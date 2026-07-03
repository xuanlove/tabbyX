import * as url from 'url'
const __dirname = url.fileURLToPath(new URL('.', import.meta.url))

import config from '../webpack.plugin.config.mjs'

export default () => config({
    name: 'cloud-sync',
    dirname: __dirname,
    externals: [
        // 这些后端库较大且有动态 import，运行时从 node_modules 加载更稳妥
        'webdav',
        'basic-ftp',
        /^@aws-sdk\//,
    ],
})
