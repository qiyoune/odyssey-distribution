const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const DISTRO_DIR = __dirname;
const RAW_BASE_URL = 'https://raw.githubusercontent.com/qiyoune/odyssey-distribution/main';
const MEDIA_BASE_URL = 'https://media.githubusercontent.com/media/qiyoune/odyssey-distribution/main';

function computeHashes(filePath) {
    const buffer = fs.readFileSync(filePath);
    const md5 = crypto.createHash('md5').update(buffer).digest('hex');
    const sha1 = crypto.createHash('sha1').update(buffer).digest('hex');
    return {
        size: buffer.length,
        md5,
        sha1
    };
}

function fetchUrl(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetchUrl(res.headers.location).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`Failed to fetch ${url}, status code: ${res.statusCode}`));
            }
            let data = [];
            res.on('data', chunk => data.push(chunk));
            res.on('end', () => resolve(Buffer.concat(data)));
        }).on('error', reject);
    });
}

function parseMavenId(filename) {
    const base = filename.replace(/\.jar$/i, '');
    const match = base.match(/^(.+?)[-_]((?:[0-9]|v[0-9]).*)$/);
    if (match) {
        let artifact = match[1].toLowerCase();
        let version = match[2];
        return `fr.odyssey:${artifact}:${version}`;
    }
    return `fr.odyssey:${base.toLowerCase()}:1.0.0`;
}

function formatName(filename) {
    const base = filename.replace(/\.jar$/i, '');
    const match = base.match(/^(.+?)[-_]((?:[0-9]|v[0-9]).*)$/);
    if (match) {
        const namePart = match[1].replace(/[-_]/g, ' ');
        return `${namePart} (${match[2]})`;
    }
    return base;
}

async function main() {
    console.log('Generating distribution.json for Odyssey server...');

    const nebulaPath = path.join(DISTRO_DIR, 'nebula.json');
    let nebulaConfig = {};
    if (fs.existsSync(nebulaPath)) {
        const content = fs.readFileSync(nebulaPath, 'utf-8').replace(/^\uFEFF/, '');
        nebulaConfig = JSON.parse(content);
    }

    const mcVersion = "1.21.1";
    const fabricVersion = "0.19.3";

    // 1. Prepare Fabric Loader & Version Manifest
    console.log(`Fetching Fabric metadata for MC ${mcVersion} Loader ${fabricVersion}...`);
    const fabricMetaUrl = `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/${fabricVersion}/profile/json`;
    const fabricManifestBuf = await fetchUrl(fabricMetaUrl);
    const fabricManifestJson = JSON.parse(fabricManifestBuf.toString('utf-8'));

    const manifestVersionId = `${mcVersion}-fabric-${fabricVersion}`;
    const manifestRelativePath = `files/versions/${manifestVersionId}/${manifestVersionId}.json`;
    const manifestAbsPath = path.join(DISTRO_DIR, manifestRelativePath);

    fs.mkdirSync(path.dirname(manifestAbsPath), { recursive: true });
    fs.writeFileSync(manifestAbsPath, JSON.stringify(fabricManifestJson, null, 2), 'utf-8');
    const manifestHashes = computeHashes(manifestAbsPath);

    // Download or verify fabric loader jar
    const fabricLoaderJarUrl = `https://maven.fabricmc.net/net/fabricmc/fabric-loader/${fabricVersion}/fabric-loader-${fabricVersion}.jar`;
    console.log(`Fetching Fabric loader JAR...`);
    const fabricLoaderBuf = await fetchUrl(fabricLoaderJarUrl);

    const loaderRelativePath = `files/libraries/net/fabricmc/fabric-loader/${fabricVersion}/fabric-loader-${fabricVersion}.jar`;
    const loaderAbsPath = path.join(DISTRO_DIR, loaderRelativePath);
    fs.mkdirSync(path.dirname(loaderAbsPath), { recursive: true });
    fs.writeFileSync(loaderAbsPath, fabricLoaderBuf);
    const loaderHashes = computeHashes(loaderAbsPath);

    const fabricSubModules = [
        {
            id: manifestVersionId,
            name: "Fabric Version Manifest",
            type: "VersionManifest",
            artifact: {
                size: manifestHashes.size,
                MD5: manifestHashes.md5,
                url: `${RAW_BASE_URL}/${manifestRelativePath}`
            }
        }
    ];

    if (Array.isArray(fabricManifestJson.libraries)) {
        for (const lib of fabricManifestJson.libraries) {
            if (lib && lib.name) {
                const parts = lib.name.split(':');
                const groupPath = parts[0].replace(/\./g, '/');
                const name = parts[1];
                const version = parts[2];
                const classifier = parts[3] ? `-${parts[3]}` : '';
                const jarName = `${name}-${version}${classifier}.jar`;
                const relPath = `files/libraries/${groupPath}/${name}/${version}/${jarName}`;
                const absPath = path.join(DISTRO_DIR, relPath);

                fs.mkdirSync(path.dirname(absPath), { recursive: true });

                const mavenUrl = (lib.url || 'https://maven.fabricmc.net/') + `${groupPath}/${name}/${version}/${jarName}`;
                console.log(`Fetching Fabric library ${lib.name}...`);
                try {
                    const libBuf = await fetchUrl(mavenUrl);
                    fs.writeFileSync(absPath, libBuf);
                    const libHashes = computeHashes(absPath);

                    fabricSubModules.push({
                        id: lib.name,
                        name: `${name} (${version})`,
                        type: "Library",
                        artifact: {
                            size: libHashes.size,
                            MD5: libHashes.md5,
                            url: mavenUrl
                        }
                    });
                } catch (e) {
                    console.warn(`Failed to fetch library ${lib.name}: ${e.message}`);
                }
            }
        }
    }

    const fabricModule = {
        id: `net.fabricmc:fabric-loader:${fabricVersion}`,
        name: `Fabric Loader ${fabricVersion}`,
        type: "Fabric",
        artifact: {
            size: loaderHashes.size,
            MD5: loaderHashes.md5,
            url: fabricLoaderJarUrl
        },
        subModules: fabricSubModules
    };

    // 2. Process Mod Jars
    const modsDir = path.join(DISTRO_DIR, 'files', 'servers', 'odyssey', 'mods');
    const modFiles = fs.readdirSync(modsDir).filter(f => f.endsWith('.jar'));

    console.log(`Processing ${modFiles.length} mod JARs...`);
    const modModules = [];

    for (const file of modFiles) {
        const filePath = path.join(modsDir, file);
        const hashes = computeHashes(filePath);
        const mavenId = parseMavenId(file);
        const displayName = formatName(file);

        console.log(` - ${file} [MD5: ${hashes.md5}, SHA1: ${hashes.sha1}]`);

        modModules.push({
            id: mavenId,
            name: displayName,
            type: "FabricMod",
            artifact: {
                size: hashes.size,
                MD5: hashes.md5,
                path: file,
                url: `${MEDIA_BASE_URL}/files/servers/odyssey/mods/${encodeURIComponent(file)}`
            }
        });
    }

    // 3. Assemble distribution.json
    const distroJson = {
        version: "1.1.0",
        rss: `${RAW_BASE_URL}/news.rss`,
        servers: [
            {
                id: "odyssey",
                name: "Cobblemon Odyssey",
                description: "Serveur officiel Cobblemon Odyssey - 1.21.1",
                icon: `${RAW_BASE_URL}/icon.png`,
                version: "1.1.0",
                address: "localhost:25565",
                minecraftVersion: mcVersion,
                javaOptions: {
                    supported: ">=21",
                    suggestedMajor: 21,
                    ram: {
                        recommended: 4096,
                        minimum: 2048
                    }
                },
                mainServer: true,
                autoconnect: true,
                modules: [
                    fabricModule,
                    ...modModules
                ]
            }
        ]
    };

    const distroPath = path.join(DISTRO_DIR, 'distribution.json');
    fs.writeFileSync(distroPath, JSON.stringify(distroJson, null, 2), 'utf-8');
    console.log(`\nSuccessfully generated distribution.json at: ${distroPath}`);
}

main().catch(err => {
    console.error('Error generating distribution:', err);
    process.exit(1);
});
