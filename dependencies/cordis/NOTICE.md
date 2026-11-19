# Cordis 浏览器运行时

本目录随扩展离线分发，使用上游已发布的 CommonJS 文件：

| 本地文件 | 上游文件 | 许可证 |
| --- | --- | --- |
| `core.js` | [@cordisjs/core@3.18.1/lib/index.cjs](https://unpkg.com/@cordisjs/core@3.18.1/lib/index.cjs) | MIT |
| `cosmokit.js` | [cosmokit@1.6.2/lib/index.cjs](https://unpkg.com/cosmokit@1.6.2/lib/index.cjs) | MIT |

两个项目的版权均为 Copyright (c) 2021-present Shigma，完整许可见 [LICENSE](LICENSE)。

项目：[Cordis](https://github.com/cordiverse/cordis) · [Cosmokit](https://github.com/shigma/cosmokit)。

本地修改仅为文件首尾添加严格模式 IIFE 包装、局部 `module` 和浏览器全局导出；`core.js` 的局部 `require` 仅映射 Cosmokit。上游文件正文保持原样。发布脚本不再压缩本目录。上游的 source map 注释保留，但不随包提供 map 文件。

版本与 npm 下载完整性记录在根目录 `package-lock.json`。升级时需同时更新锁文件、本目录的上游正文及此声明，保留包装；`npm install` 不会自动更新这些随包文件。采用 3.x 插件 API，仅引入核心和 Cosmokit，不包含 Cordis CLI、文件系统加载器或 Node.js 插件。
