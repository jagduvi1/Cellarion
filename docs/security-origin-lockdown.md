# Lock the origin to Cloudflare (close the direct-IP bypass)

**Problem (found 2026-06-11):** `https://95.217.2.253` (the VM's public IP) serves the live app directly, bypassing Cloudflare entirely — no WAF, no edge rate-limiting, no maintenance page, and an attacker can spoof their source IP past the per-IP limiters. The IP is discoverable, so "nobody knows it" is not protection.

**Goal:** make ports 80/443 reachable **only** from Cloudflare's network, so every visitor is forced through Cloudflare. Keep SSH (22) reachable so you can never lock yourself out.

There are two ways. **Option A (Hetzner Cloud Firewall) is strongly recommended** — it runs at Hetzner's edge, before traffic reaches the VM, so a mistake can't cut your SSH and there's nothing to misconfigure on the box itself.

---

## Option A — Hetzner Cloud Firewall (recommended)

All in the browser, at <https://console.hetzner.cloud> → your project → **Firewalls**.

1. **Create firewall**, name it `cellarion-origin`.
2. **Inbound rules** (delete the default allow-all, then add):

   | # | Protocol | Port | Source IPs | Purpose |
   |---|----------|------|-----------|---------|
   | 1 | TCP | 22 | *your home/office IP* `/32` (or `0.0.0.0/0` + `::/0` if your IP is dynamic) | SSH |
   | 2 | TCP | 80 | **Cloudflare IPv4 ranges** | HTTP via Cloudflare |
   | 3 | TCP | 80 | **Cloudflare IPv6 ranges** | HTTP via Cloudflare |
   | 4 | TCP | 443 | **Cloudflare IPv4 ranges** | HTTPS via Cloudflare |
   | 5 | TCP | 443 | **Cloudflare IPv6 ranges** | HTTPS via Cloudflare |

   - Outbound: leave as "allow all" (default).
   - Cloudflare's current ranges (paste into the Source field, comma-separated — Hetzner accepts multiple CIDRs per rule):
     - IPv4: <https://www.cloudflare.com/ips-v4>
     - IPv6: <https://www.cloudflare.com/ips-v6>
   - ⚠️ These ranges change a few times a year. Re-check the two URLs every few months (or subscribe to Cloudflare's IP-range change notices). If a range is added and you haven't updated, some visitors get blocked — symptom: intermittent 5xx/timeouts for some users only.
3. **Apply to** → select your server (`ubuntu-4gb-hel1-1`) → **Create Firewall**.
4. **Verify** (from your PC):
   ```powershell
   # Should now FAIL / time out (origin no longer answers the raw IP):
   curl.exe -k --max-time 8 -H "Host: cellarion.app" https://95.217.2.253/api/health
   # Should still WORK (through Cloudflare):
   curl.exe https://cellarion.app/api/health
   # SSH should still WORK:
   ssh johan@95.217.2.253 "echo ok"
   ```
   The first command failing while the other two succeed = the bypass is closed.

> If SSH (#1) is set to your specific IP and your ISP later changes it, you'd lose SSH. You can always re-open it from the Hetzner Cloud console (the firewall is editable there) or via the server's web console — you cannot be permanently locked out.

---

## Option B — ufw on the host (alternative, riskier)

Only if you don't want a Cloudflare-edge firewall. Run on the VM. The script pulls Cloudflare's live ranges so it never goes stale at apply-time.

```bash
# 1. Keep SSH open FIRST (so a mistake can't lock you out)
sudo ufw allow 22/tcp

# 2. Allow 80/443 only from Cloudflare's current ranges
for ip in $(curl -s https://www.cloudflare.com/ips-v4) $(curl -s https://www.cloudflare.com/ips-v6); do
  sudo ufw allow from "$ip" to any port 80  proto tcp
  sudo ufw allow from "$ip" to any port 443 proto tcp
done

# 3. Default deny everything else inbound, allow outbound
sudo ufw default deny incoming
sudo ufw default allow outgoing

# 4. Turn it on (answer 'y') and check
sudo ufw enable
sudo ufw status verbose
```

Re-run step 2 whenever Cloudflare's ranges change (and `sudo ufw reload`). This is why Option A (managed) is preferred.

---

## While you're in Cloudflare — two free hardening wins

1. **HSTS** (the one security header we deferred to the TLS layer): Cloudflare dashboard → your domain → **SSL/TLS → Edge Certificates → HTTP Strict Transport Security (HSTS) → Enable**. Use `max-age` 6 months, IncludeSubDomains on. Consider "Preload" only once you're sure all subdomains are HTTPS-only.
2. **SSL/TLS mode = Full (strict)** (SSL/TLS → Overview): ensures Cloudflare validates the origin certificate, preventing a man-in-the-middle on the Cloudflare→origin hop.

---

## Gold-standard future option (no public IP at all)

A **Cloudflare Tunnel** (`cloudflared` running on the VM) removes the need for any inbound public ports — the VM dials *out* to Cloudflare, and you can then firewall 80/443 shut entirely (keep only 22, or tunnel SSH too). It's a bigger change than the firewall above, but it makes the direct-IP bypass structurally impossible. Worth considering once the firewall is in place.
