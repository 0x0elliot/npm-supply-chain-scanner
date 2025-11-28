# NPM Supply Chain Scanner

Fast, comprehensive security scanner for npm dependencies using the OSV database to detect malicious packages in your supply chain.

## Features

- **Fast**: Uses OSV API batch queries instead of downloading entire database
- **Comprehensive**: Scans all dependencies including transitive ones
- **Automatic**: Generates lock files if missing
- **Multi-project**: Scans all package.json files in repository
- **Hourly updates**: OSV database is updated hourly with new threats

## Quick Start

### As a GitHub Action

```yaml
name: Security Check

on: [push, pull_request]

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4
    - uses: 0x0elliot/npm-supply-chain-scanner@v0.0.2
```

### Local Usage

```bash
# Download the script
curl -O https://raw.githubusercontent.com/0x0elliot/npm-supply-chain-scanner/main/check-malicious.js

# Run the scan
node check-malicious.js
```

## How It Works

1. **Discovers** all `package.json` files in your repository
2. **Locates** or generates lock files (`package-lock.json` or `yarn.lock`)
3. **Extracts** all dependencies including transitive ones
4. **Queries** OSV database API for malicious packages
5. **Reports** any detected threats and fails CI if found

## Performance

- API-based approach is ~100x faster than cloning the full database
- Batches queries (1000 packages per request)
- Typically completes in seconds, even for large projects

## Requirements

- Node.js 14+
- Either `npm` or `yarn` installed (for lock file generation)
- Internet connection (for OSV API)

## Output Example

```
🛡️  NPM Supply Chain DETECTOR
════════════════════════════════════════

Found 3 package.json file(s)

📦 package.json
  Dependencies: 142
  Querying OSV database...
  ✅ Clean

📦 frontend/package.json
  Dependencies: 856
  Querying OSV database...
  🚨 MALICIOUS: 1 package(s)
     • colors-update@2.0.0
       MAL-2024-1234

════════════════════════════════════════

🚨 MALICIOUS PACKAGES DETECTED!

• colors-update@2.0.0
  Location: frontend/package.json
  MAL-2024-1234

⚠️  Remove these packages immediately!
```

## License

MIT
