#!/bin/sh
set -e

# Executed automatically by the official nginx image entrypoint through /docker-entrypoint.d/*.sh before nginx starts.
# Generate runtime config.js from environment variables. Each analytics provider has an independent variable;
# IDs never grant consent. Each provider still requires the user's separate session opt-in.

# GA4 and Baidu IDs contain only letters, numbers, and hyphens. Remove other characters
# so quotes and similar values cannot break the JavaScript strings in config.js as a defense-in-depth measure.
sanitize_id() {
    printf '%s' "$1" | tr -cd 'A-Za-z0-9-'
}

GA4_ID=$(sanitize_id "${ANALYTICS_GA4_ID:-}")
BAIDU_ID=$(sanitize_id "${ANALYTICS_BAIDU_ID:-}")

# Emit booleans as fixed strings, never interpolate arbitrary environment values into JavaScript.
disabled() {
    if [ "$1" = "true" ]; then printf true; else printf false; fi
}

cat > /usr/share/nginx/html/config.js <<EOF
window.__RUNTIME_CONFIG__ = {
  ANALYTICS_GA4_ID: "${GA4_ID}",
  ANALYTICS_BAIDU_ID: "${BAIDU_ID}",
  DISABLE_ANALYTICS: "$(disabled "${DISABLE_ANALYTICS:-}")",
  DISABLE_VERSION_CHECK: "$(disabled "${DISABLE_VERSION_CHECK:-}")",
  DISABLE_PROMPT_FEED: "$(disabled "${DISABLE_PROMPT_FEED:-}")"
};
EOF
