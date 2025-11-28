#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

// OSV API endpoint
const OSV_API_URL = 'https://api.osv.dev/v1/querybatch';

function findPackageJsonFiles(dir, files = []) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
            continue;
        }
        
        if (entry.isDirectory()) {
            findPackageJsonFiles(fullPath, files);
        } else if (entry.name === 'package.json') {
            files.push(fullPath);
        }
    }
    
    return files;
}

function generateLockFile(packageJsonPath) {
    const dir = path.dirname(packageJsonPath);
    const packageLockPath = path.join(dir, 'package-lock.json');
    const yarnLockPath = path.join(dir, 'yarn.lock');
    
    // Check if lock file already exists
    if (fs.existsSync(packageLockPath) || fs.existsSync(yarnLockPath)) {
        return fs.existsSync(packageLockPath) ? packageLockPath : yarnLockPath;
    }
    
    console.log(`  ⚠️  No lock file found, generating one...`);
    
    try {
        // Try npm first (it's more commonly available)
        execSync('npm install --package-lock-only --ignore-scripts', { 
            cwd: dir, 
            stdio: 'pipe' 
        });
        
        if (fs.existsSync(packageLockPath)) {
            console.log(`  ✓ Generated package-lock.json`);
            return packageLockPath;
        }
    } catch (e) {
        // npm failed, try yarn
        try {
            execSync('yarn install --mode skip-build', { 
                cwd: dir, 
                stdio: 'pipe' 
            });
            
            if (fs.existsSync(yarnLockPath)) {
                console.log(`  ✓ Generated yarn.lock`);
                return yarnLockPath;
            }
        } catch (e2) {
            console.log(`  ✗ Could not generate lock file: ${e2.message}`);
            return null;
        }
    }
    
    return null;
}

function parsePackageLock(lockPath) {
    const deps = new Map(); // name -> version
    const lockData = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    
    // Handle v1/v2 format
    if (lockData.dependencies) {
        function extractDeps(dependencies) {
            for (const [name, info] of Object.entries(dependencies)) {
                deps.set(name, info.version || 'unknown');
                if (info.dependencies) {
                    extractDeps(info.dependencies);
                }
            }
        }
        extractDeps(lockData.dependencies);
    }
    
    // Handle v3 format
    if (lockData.packages) {
        for (const [key, info] of Object.entries(lockData.packages)) {
            if (key && key !== '') {
                const name = key.replace(/^node_modules\//, '');
                if (name && !name.includes('node_modules')) {
                    deps.set(name, info.version || 'unknown');
                }
            }
        }
    }
    
    return deps;
}

function parseYarnLock(lockPath) {
    const deps = new Map();
    const content = fs.readFileSync(lockPath, 'utf8');
    const lines = content.split('\n');
    
    let currentPackage = null;
    for (const line of lines) {
        // Match package entries
        const packageMatch = line.match(/^"?(@?[^@\s]+)@[^"]*"?:$/);
        if (packageMatch) {
            currentPackage = packageMatch[1];
            continue;
        }
        
        // Match version line
        if (currentPackage && line.includes('version')) {
            const versionMatch = line.match(/version\s+"([^"]+)"/);
            if (versionMatch) {
                deps.set(currentPackage, versionMatch[1]);
                currentPackage = null;
            }
        }
    }
    
    return deps;
}

async function queryOSV(packages) {
    const queries = Array.from(packages).map(([name, version]) => ({
        package: {
            name: name,
            ecosystem: 'npm'
        },
        version: version
    }));
    
    // Split into batches of 1000 (OSV API limit)
    const results = [];
    const batchSize = 1000;
    
    for (let i = 0; i < queries.length; i += batchSize) {
        const batch = queries.slice(i, i + batchSize);
        
        const data = JSON.stringify({ queries: batch });
        
        const result = await new Promise((resolve, reject) => {
            const options = {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data)
                }
            };
            
            const req = https.request(OSV_API_URL, options, (res) => {
                let responseData = '';
                res.on('data', chunk => responseData += chunk);
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(responseData);
                        resolve(parsed);
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            
            req.on('error', reject);
            req.write(data);
            req.end();
        });
        
        results.push(...(result.results || []));
        
        // Show progress for large batches
        if (queries.length > batchSize) {
            const processed = Math.min(i + batchSize, queries.length);
            console.log(`  Checked ${processed}/${queries.length} packages...`);
        }
    }
    
    return results;
}

async function main() {
    console.log('NPM Supply Chain Scanner');
    console.log('━'.repeat(40) + '\n');
    
    // Find all package.json files
    const packageJsonFiles = findPackageJsonFiles(process.cwd());
    
    if (packageJsonFiles.length === 0) {
        console.log('No package.json files found in this repository.');
        console.log('Nothing to scan - exiting successfully.');
        process.exit(0);
    }
    
    console.log(`Found ${packageJsonFiles.length} package.json file(s)\n`);
    
    let hasVulnerabilities = false;
    const allFindings = [];
    const tempLockFiles = [];
    
    // Process each package.json
    for (const packageJsonPath of packageJsonFiles) {
        const relativePath = path.relative(process.cwd(), packageJsonPath);
        const dir = path.dirname(packageJsonPath);
        console.log(`📦 ${relativePath}`);
        
        // Find or generate lock file
        let lockFile = path.join(dir, 'package-lock.json');
        if (!fs.existsSync(lockFile)) {
            lockFile = path.join(dir, 'yarn.lock');
            if (!fs.existsSync(lockFile)) {
                lockFile = generateLockFile(packageJsonPath);
                if (lockFile && !fs.existsSync(lockFile.replace(/\.(json|lock)$/, '.json'))) {
                    tempLockFiles.push(lockFile);
                }
            }
        }
        
        if (!lockFile) {
            console.log(`  ✗ Skipping - no lock file available\n`);
            continue;
        }
        
        // Parse dependencies
        let dependencies;
        try {
            if (lockFile.endsWith('package-lock.json')) {
                dependencies = parsePackageLock(lockFile);
            } else {
                dependencies = parseYarnLock(lockFile);
            }
        } catch (e) {
            console.error(`  ✗ Parse error: ${e.message}\n`);
            continue;
        }
        
        console.log(`  Dependencies: ${dependencies.size}`);
        
        if (dependencies.size === 0) {
            console.log(`  ✓ No dependencies to check\n`);
            continue;
        }
        
        // Query OSV API
        console.log(`  Querying OSV database...`);
        const results = await queryOSV(dependencies);
        
        // Process results
        const vulnerabilities = [];
        const packagesArray = Array.from(dependencies.keys());
        
        for (let i = 0; i < results.length; i++) {
            if (results[i].vulns && results[i].vulns.length > 0) {
                const packageName = packagesArray[i];
                for (const vuln of results[i].vulns) {
                    // Check if it's marked as malicious
                    const isMalicious = vuln.id.startsWith('MAL-') || 
                                       (vuln.details && vuln.details.toLowerCase().includes('malicious')) ||
                                       (vuln.summary && vuln.summary.toLowerCase().includes('malicious'));
                    
                    if (isMalicious) {
                        vulnerabilities.push({
                            package: packageName,
                            version: dependencies.get(packageName),
                            id: vuln.id,
                            summary: vuln.summary || 'Malicious package detected'
                        });
                        hasVulnerabilities = true;
                    }
                }
            }
        }
        
        if (vulnerabilities.length > 0) {
            console.log(`  🚨 MALICIOUS: ${vulnerabilities.length} package(s)`);
            vulnerabilities.forEach(v => {
                console.log(`     • ${v.package}@${v.version}`);
                console.log(`       ${v.id}`);
                allFindings.push({ file: relativePath, ...v });
            });
        } else {
            console.log(`  ✅ Clean`);
        }
        console.log('');
    }
    
    // Cleanup temporary lock files
    for (const lockFile of tempLockFiles) {
        try {
            fs.unlinkSync(lockFile);
            console.log(`Cleaned up temporary ${path.basename(lockFile)}`);
        } catch (e) {}
    }
    
    // Final report
    console.log('━'.repeat(40));
    if (hasVulnerabilities) {
        console.log('\n🚨 MALICIOUS PACKAGES DETECTED!\n');
        allFindings.forEach(({ file, package: pkg, version, id }) => {
            console.log(`• ${pkg}@${version}`);
            console.log(`  Location: ${file}`);
            console.log(`  ${id}`);
        });
        console.log('\n⚠️  Remove these packages immediately!');
        process.exit(1);
    } else {
        console.log('\n✅ All clear - no malicious packages found');
        process.exit(0);
    }
}

main().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
});