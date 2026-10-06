"""
Instagram DM MQTT Monitor (sidecar)
Replaces Zernio as the DM trigger using moeinimy's aiograpi MQTT method.

Flow:
1. On first run: if IG_PASSWORD env is set and no session exists,
   performs mobile login and saves session to SESSION_FILE.
   (User removes IG_PASSWORD after this - it's never needed again.)
2. Connects via MQTT (MQTToT), subscribes to DM events.
3. On share detection: extracts shortcode, POSTs to n8n webhook.

Env vars:
- IG_USERNAME: Instagram username (sacrificial account)
- IG_PASSWORD: Instagram password (ONLY needed for first login, then remove)
- IG_SESSION_JSON: (optional) existing session JSON to bootstrap
- SESSION_FILE: path to session file (default: /app/session.json)
- N8N_WEBHOOK_URL: n8n webhook for MQTT triggers
- POLL_INTERVAL: reconnect backoff base (default: 20)
"""

import asyncio
import json
import re
import logging
import os
import sys
from pathlib import Path

import httpx

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("mqtt-monitor")

# Config
IG_USERNAME = os.environ.get("IG_USERNAME", "")
IG_PASSWORD = os.environ.get("IG_PASSWORD", "")
SESSION_FILE = Path(os.environ.get("SESSION_FILE", "/app/session.json"))
N8N_WEBHOOK_URL = os.environ.get("N8N_WEBHOOK_URL", "")
SHARE_TYPES = {"media_share", "clip", "xma_media_share", "reel_share"}



def describe_structure(obj, prefix="", max_depth=3, _depth=0):
    """Safely describe the structure (keys and types only, no values)."""
    if _depth > max_depth:
        return prefix + "... (max depth)"
    lines = []
    if isinstance(obj, dict):
        for k in list(obj.keys())[:20]:  # Limit to 20 keys
            v = obj[k]
            t = type(v).__name__
            if isinstance(v, (dict, list)):
                lines.append(f"{prefix}{k} ({t})")
                if _depth < max_depth:
                    sub = describe_structure(v, prefix + "  ", max_depth, _depth + 1)
                    if sub:
                        lines.append(sub)
            else:
                # For strings, show length but not content (might be sensitive)
                if isinstance(v, str) and len(v) > 100:
                    lines.append(f"{prefix}{k} (str, len={len(v)})")
                else:
                    lines.append(f"{prefix}{k} ({t})")
    elif isinstance(obj, list):
        lines.append(f"{prefix}[list len={len(obj)}]")
        if obj and _depth < max_depth:
            sub = describe_structure(obj[0], prefix + "  ", max_depth, _depth + 1)
            if sub:
                lines.append(f"{prefix}  [0]:")
                lines.append(sub)
    return "\n".join(lines)


def find_share_codes(obj, out, _depth=0):
    """Walk nested dicts/lists; find share codes by multiple strategies."""
    if _depth > 20:
        return
    if isinstance(obj, dict):
        # Strategy 1: item_type based (original)
        item_type = obj.get("item_type", "")
        if item_type in SHARE_TYPES:
            code = None
            for key in ("media_share", "clip", "reel_share", "xma_media_share"):
                media = obj.get(key)
                if isinstance(media, dict):
                    code = media.get("code")
                    if code:
                        break
            if not code:
                code = obj.get("code")
            if code:
                out.append((item_type, code))
        
        # Strategy 2: Look for instagram.com URLs in any string value
        # Shares often contain the URL directly
        for k, v in obj.items():
            if isinstance(v, str) and "instagram.com" in v:
                m = re.search(r'instagram\.com/(?:p|reel|reels|tv)/([A-Za-z0-9_-]+)', v)
                if m:
                    out.append(("url_share", m.group(1)))
        
        # Strategy 3: Look for 'code' field that looks like a shortcode
        # (11 chars, alphanumeric + _ -)
        code_val = obj.get("code", "")
        if isinstance(code_val, str) and re.match(r'^[A-Za-z0-9_-]{11}$', code_val):
            # Check if this looks like a media object (has other media fields)
            if any(k in obj for k in ("id", "pk", "media_type", "taken_at")):
                out.append(("code_field", code_val))
        
        for v in obj.values():
            # Strategy 4: Parse JSON strings
            if isinstance(v, str) and v.strip().startswith(("{", "[")):
                try:
                    parsed = json.loads(v)
                    find_share_codes(parsed, out, _depth + 1)
                except:
                    pass
            else:
                find_share_codes(v, out, _depth + 1)
    elif isinstance(obj, list):
        for v in obj:
            find_share_codes(v, out, _depth + 1)
    elif isinstance(obj, str) and obj.strip().startswith(("{", "[")):
        try:
            parsed = json.loads(obj)
            find_share_codes(parsed, out, _depth + 1)
        except:
            pass



def notify_n8n(item_type, code):
    """POST the share to n8n webhook."""
    if not N8N_WEBHOOK_URL:
        log.warning("N8N_WEBHOOK_URL not set, skipping notify for %s", code)
        return
    # Determine URL kind from item_type
    kind = "reel" if item_type in ("clip", "reel_share") else "p"
    url = f"https://www.instagram.com/{kind}/{code}/"
    payload = {
        "source": "mqtt",
        "item_type": item_type,
        "shortcode": code,
        "shared_url": url,
    }
    try:
        r = httpx.post(N8N_WEBHOOK_URL, json=payload, timeout=10)
        log.info("Notified n8n for %s: HTTP %s", code, r.status_code)
    except Exception as e:
        log.error("Failed to notify n8n for %s: %s", code, e)


async def ensure_session():
    """Ensure we have a valid mobile session. Returns aiograpi Client."""
    from aiograpi import Client

    cl = Client()

    # Try IG_SESSIONID env (cookie-based, bypasses password login endpoint)
    # This is unreliable for mobile API but worth trying when password login is rate-limited
    sessionid = os.environ.get("IG_SESSIONID", "")
    if sessionid:
        try:
            log.info("Trying login_by_sessionid...")
            await cl.login_by_sessionid(sessionid)
            cl.dump_settings(str(SESSION_FILE))
            log.info("Sessionid login successful! Session saved.")
            return cl
        except Exception as e:
            log.warning("login_by_sessionid failed: %s", e)

    # Try loading existing session
    if SESSION_FILE.exists():
        try:
            cl.load_settings(str(SESSION_FILE))
            log.info("Loaded existing session from %s", SESSION_FILE)
            # Verify by attempting login (reuses stored session)
            await cl.login(IG_USERNAME, IG_PASSWORD or "dummy")
            log.info("Session valid, logged in as %s", IG_USERNAME)
            return cl
        except Exception as e:
            log.warning("Stored session invalid: %s", e)

    # Try IG_SESSION_JSON env bootstrap
    session_json = os.environ.get("IG_SESSION_JSON", "")
    if session_json:
        try:
            settings = json.loads(session_json)
            cl.set_settings(settings)
            await cl.login(IG_USERNAME, IG_PASSWORD or "dummy")
            cl.dump_settings(str(SESSION_FILE))
            log.info("Bootstrapped from IG_SESSION_JSON, saved to %s", SESSION_FILE)
            return cl
        except Exception as e:
            log.warning("IG_SESSION_JSON bootstrap failed: %s", e)

    # Fresh login with password (one-time)
    if not IG_USERNAME or not IG_PASSWORD:
        log.error(
            "No valid session and IG_PASSWORD not set. "
            "Set IG_USERNAME and IG_PASSWORD env vars for one-time login, "
            "then remove IG_PASSWORD after session is minted."
        )
        sys.exit(1)

    log.info("Performing one-time mobile login for %s...", IG_USERNAME)
    await cl.login(IG_USERNAME, IG_PASSWORD)
    cl.dump_settings(str(SESSION_FILE))
    log.info(
        "Login successful! Session saved to %s. "
        "You can now REMOVE IG_PASSWORD from env vars.",
        SESSION_FILE,
    )
    return cl


async def mqtt_loop():
    """Main MQTT loop with reconnect backoff."""
    from aiograpi import Client

    backoff = int(os.environ.get("POLL_INTERVAL", "20"))
    max_backoff = 300

    while True:
        try:
            cl = await ensure_session()
            seen_codes = set()

            _structure_logged = [False]  # Use list for closure
            
            def on_message(payload):
                try:
                    # Log structure safely on first message (keys/types only)
                    if not _structure_logged[0]:
                        _structure_logged[0] = True
                        try:
                            struct = describe_structure(payload)
                            log.info("Payload structure:\n%s", struct)
                        except Exception as e:
                            log.warning("Could not describe structure: %s", e)
                    
                    found = []
                    find_share_codes(payload, found)
                    log.info("Found %d share codes in payload", len(found))
                    for item_type, code in found:
                        if code not in seen_codes:
                            seen_codes.add(code)
                            log.info("Share detected: %s (%s)", code, item_type)
                            notify_n8n(item_type, code)
                except Exception as e:
                    log.error("Error handling message: %s", e)

            cl.realtime_on("message", on_message)
            log.info("Connecting to Instagram MQTT...")
            rt = await cl.realtime_connect()
            await rt.direct_subscribe()
            await rt.ping()
            log.info("MQTT connected, listening for DMs (zero idle requests)")

            # Reset backoff on successful connect
            backoff = int(os.environ.get("POLL_INTERVAL", "20"))

            while True:
                await cl.realtime_read_once()

        except KeyboardInterrupt:
            log.info("Shutting down")
            break
        except Exception as e:
            err_str = str(e).lower()
            # Permanent failures - don't retry
            if "user_has_logged_out" in err_str or "login_required" in err_str:
                log.error("Logged out or login required: %s. Manual intervention needed.", e)
                # Delete bad session to force fresh login next time
                if SESSION_FILE.exists():
                    SESSION_FILE.unlink()
                sys.exit(1)
            if "checkpoint_required" in err_str:
                log.error("Checkpoint required: %s. Resolve in app, then restart.", e)
                sys.exit(1)
            # Transient - reconnect with backoff
            log.warning("MQTT error: %s. Reconnecting in %ss...", e, backoff)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, max_backoff)


def main():
    if not IG_USERNAME:
        log.error("IG_USERNAME env var is required")
        sys.exit(1)
    asyncio.run(mqtt_loop())


if __name__ == "__main__":
    main()
