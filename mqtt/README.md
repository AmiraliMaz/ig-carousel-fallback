# Instagram DM MQTT Monitor (Sidecar)

Replaces Zernio as the DM trigger using aiograpi's MQTT (moeinimy's method).

## How it works

1. **First run**: Set `IG_USERNAME` and `IG_PASSWORD`. The sidecar performs a one-time
   mobile login and saves the session to `session.json`. **Remove `IG_PASSWORD` after this.**
2. **Steady state**: Connects via MQTT (MQTToT), subscribes to DM events.
   Zero HTTP requests while idle - Instagram pushes new DMs.
3. **On share**: Extracts the shortcode, POSTs to the n8n webhook.

## Railway Setup

1. Create a new service from this repo, root directory: `mqtt`
2. Set env vars:
   - `IG_USERNAME`: sacrificial account username
   - `IG_PASSWORD`: sacrificial account password (TEMPORARY - remove after first login)
   - `N8N_WEBHOOK_URL`: e.g. `https://n8n-production-1542.up.railway.app/webhook/mqtt-ig-dm`
3. Deploy. Check logs for "Login successful! ... You can now REMOVE IG_PASSWORD"
4. Remove `IG_PASSWORD` from env vars and redeploy.

## n8n Webhook

The sidecar POSTs to `N8N_WEBHOOK_URL` with:
```json
{
  "source": "mqtt",
  "item_type": "clip",
  "shortcode": "Dd3_M8GBgJk",
  "shared_url": "https://www.instagram.com/reel/Dd3_M8GBgJk/"
}
```
