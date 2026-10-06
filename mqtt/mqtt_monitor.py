"""
Instagram DM MQTT Monitor (sidecar)
Replaces Zernio as the DM trigger using moeinimy's aiograpi MQTT method.

Flow:
1. Preferred: IG_SESSION_JSON env holds a valid mobile session (minted via
   a real mobile login). It is loaded directly with NO login-endpoint calls,
   because Instagram rate-limits (429) logins from this server's IP and
   repeated failed logins risk flagging the account. A single lightweight
   API call warms/validates the session before the MQTT handshake.
2. Fallback: IG_SESSIONID cookie, stored session file, or one-time
   IG_PASSWORD login (then remove IG_PASSWORD).
3. Connects via MQTT (MQTToT), subscribes to DM events.
4. On share detection: extracts shortcode, POSTs to n8n webhook.

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

IG_USERNAME = os.environ.get("IG_USERNAME", "")
IG_PASSWORD = os.environ.get("IG_PASSWORD", "")
SESSION_FILE = Path(os.environ.get("SESSION_FILE", "/app/session.json"))
N8N_WEBHOOK_URL = os.environ.get("N8N_WEBHOOK_URL", "")
SHARE_TYPES = {"media_share", "clip", "reel_share", "xma_media_share", "reel_share"}


def find_share_codes(obj, out):
    """Walk nested dicts/lists; any dict with share item_type yields a code."""
    if isinstance(obj, dict):
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
        for v in obj.values():
            find_share_codes(v, out)
    elif isinstance(obj, list):
        for v in obj:
            find_share_codes(v, out)


def notify_n8n(item_type, code):
    """POST the share to n8n webhook."""
    if not N8N_WEBHOOK_URL:
        log.warning("N8N_WEBHOOK_URL not set, skipping notify for %s", code)
        return
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

    # Try IG_SESSION_JSON env bootstrap FIRST.
    # Deliberately makes NO login-endpoint calls: Instagram rate-limits (429)
    # logins from this server's IP, and repeated failed logins risk flagging
    # the account. The session in the JSON is already valid (minted via a
    # real mobile login). A single lightweight API call warms/validates the
    # session before the MQTT handshake (moeinimy's flow also signs in first).
    # NOTE: Do NOT call cl.login() here - the session is already valid.
    # Calling login hits the rate-limited endpoint and causes 429.
    session_json = os.environ.get("IG_SESSION_JSON", "")
    if session_json:
        try:
            settings = json.loads(session_json)
            cl.set_settings(settings)
            try:
                await cl.get_timeline_feed()
                log.info("Session validated via timeline feed")
            except Exception as e:
                log.warning("Session warm-up call failed (continuing anyway): %s", e)
            cl.dump_settings(str(SESSION_FILE))
            log.info("Bootstrapped from IG_SESSION_JSON, saved to %s", SESSION_FILE)
            return cl
        except Exception as e:
            log.warning("IG_SESSION_JSON bootstrap failed: %s", e)

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

    # Try loading existing session file (only reached when no IG_SESSION_JSON)
    if SESSION_FILE.exists():
        try:
            cl.load_settings(str(SESSION_FILE))
            log.info("Loaded existing session from %s", SESSION_FILE)
            await cl.login(IG_USERNAME, IG_PASSWORD or "dummy")
            log.info("Session valid, logged in as %s", IG_USERNAME)
            return cl
        except Exception as e:
            log.warning("Stored session invalid: %s", e)

    # Fresh login with password (one-time)
    if not IG_USERNAME or not IG_PASSWORD:
        log.error("No valid session and IG_PASSWORD not set. Set IG_USERNAME and IG_PASSWORD env vars for one-time login, then remove IG_PASSWORD after session is minted.")
        sys.exit(1)
    log.info("Performing one-time mobile login for %s...", IG_USERNAME)
    await cl.login(IG_USERNAME, IG_PASSWORD)
    cl.dump_settings(str(SESSION_FILE))
    log.info("Login successful! Session saved to %s. You can now REMOVE IG_PASSWORD from env vars.", SESSION_FILE)
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
            def on_message(payload):
                try:
                    found = []
                    find_share_codes(payload, found)
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
            backoff = int(os.environ.get("POLL_INTERVAL", "20"))
            while True:
                await cl.realtime_read_once()
        except KeyboardInterrupt:
            log.info("Shutting down")
            break
        except Exception as e:
            err_str = str(e).lower()
            if "user_has_logged_out" in err_str or "login_required" in err_str:
                log.error("Logged out or login required: %s. Manual intervention needed.", e)
                if SESSION_FILE.exists():
                    SESSION_FILE.unlink()
                sys.exit(1)
            if "checkpoint_required" in err_str:
                log.error("Checkpoint required: %s. Resolve in app, then restart.", e)
                sys.exit(1)
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
