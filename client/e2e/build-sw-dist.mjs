import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const clientRoot = path.resolve(__dirname, '..')
const marker = process.argv[2]

if (!marker || !/^[a-zA-Z0-9._-]+$/.test(marker)) {
  console.error('usage: node e2e/build-sw-dist.mjs <safe-marker>')
  process.exit(2)
}

const cacheRoot = path.join(tmpdir(), 'homecam-sw-e2e-builds')
const dist = path.join(cacheRoot, marker, 'dist')
const stampPath = path.join(cacheRoot, marker, 'marker.json')

async function runBuild() {
  await mkdir(path.dirname(dist), { recursive: true })

  await new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      [
        './node_modules/vite/bin/vite.js',
        'build',
        '--outDir',
        dist,
        '--emptyOutDir',
      ],
      {
        cwd: clientRoot,
        env: {
          ...process.env,
          VITE_BUILD_MARKER: marker,
        },
        stdio: ['ignore', 'inherit', 'inherit'],
      },
    )
    proc.on('error', reject)
    proc.on('exit', (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`vite build failed with code=${code} signal=${signal}`))
    })
  })

  const indexPath = path.join(dist, 'index.html')
  const index = await readFile(indexPath, 'utf8')
  const markerHtml = [
    `<meta name="homecam-build-marker" content="${marker}" />`,
    `<script>window.__HOMECAM_BUILD_MARKER__=${JSON.stringify(marker)}</script>`,
  ].join('\n    ')
  const markerNode =
    `<div data-homecam-build-marker="${marker}" ` +
    'style="position:fixed;left:0;bottom:0;z-index:2147483647;' +
    'font:12px monospace;background:#111;color:#fff;padding:2px 4px">' +
    `${marker}</div>`

  await writeFile(
    indexPath,
    index
      .replace('</head>', `    ${markerHtml}\n  </head>`)
      .replace('<body>', `<body>\n    ${markerNode}`),
    'utf8',
  )

  const swPath = path.join(dist, 'sw.js')
  const sw = await readFile(swPath, 'utf8')
  const swMarkerProbe = `
;self.__HOMECAM_SW_BUILD_MARKER__=${JSON.stringify(marker)};
self.addEventListener('message',(event)=>{
  if(event.data&&event.data.type==='HOMECAM_SW_MARKER'&&event.source){
    event.source.postMessage({
      type:'HOMECAM_SW_MARKER',
      marker:self.__HOMECAM_SW_BUILD_MARKER__
    });
  }
});
`
  await writeFile(swPath, `${sw}\n${swMarkerProbe}`, 'utf8')
  await writeFile(
    stampPath,
    `${JSON.stringify({ marker, dist, builtAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  )
}

async function cached() {
  try {
    const [stamp, index] = await Promise.all([
      readFile(stampPath, 'utf8'),
      readFile(path.join(dist, 'index.html'), 'utf8'),
    ])
    const parsed = JSON.parse(stamp)
    const sw = await readFile(path.join(dist, 'sw.js'), 'utf8')
    return (
      parsed.marker === marker &&
      index.includes(`data-homecam-build-marker="${marker}"`) &&
      sw.includes(`__HOMECAM_SW_BUILD_MARKER__=${JSON.stringify(marker)}`)
    )
  } catch {
    return false
  }
}

if (!(await cached())) {
  await runBuild()
}

console.log(JSON.stringify({ marker, dist }))
