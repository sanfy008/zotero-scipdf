# SciPDF For Zotero

[![zotero target version](https://img.shields.io/badge/Zotero-7+-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

[English](../README.md) | 简体中文

# 介绍
本插件帮助 Zotero 从多个来源查找并下载文献全文 PDF。
它利用 Zotero 内置的 [PDF resolvers](https://www.zotero.org/support/kb/custom_pdf_resolvers) 方案，将解析器写入 `extensions.zotero.findPDFs.resolvers` 字段，从而让 Zotero 的**查找可用的 PDF**（以及新增条目的自动下载）能够获取 PDF。

默认内置两个来源：
- **OpenAlex**（默认启用）——合法的开放获取(OA)来源。它汇聚了出版商与仓储库中的 OA 副本，常能找到 Sci-Hub 没有的全文（包括较新的论文）。当没有直链 PDF 时，会把文章的落地页交给 Zotero，由其翻译器解析出 PDF。
- **Sci-Hub**——用于较旧的付费墙论文的兜底来源。内置可靠可达的镜像（`sci-hub.se`、`sci-hub.st`、`sci-hub.ru`）。

获取顺序为先 OpenAlex 后 Sci-Hub。两者都可在插件首选项中开关与配置；可选填一个联系邮箱用于 OpenAlex（推荐，用于 API 的“polite pool”）。

**缺失 DOI 补全**（默认启用）：通过右键菜单手动获取时，若条目没有 DOI，插件会用标题（结合第一作者与年份）到 Crossref 检索，在高置信度匹配时补全 DOI 并照常获取。该功能仅在你手动点击时运行，后台自动下载不会触发，可在首选项中关闭。

> [Zotero代码](https://github.com/zotero/zotero/blob/5536f8d2bd08ddac9074b9df05b7d205273835e7/chrome/content/zotero/xpcom/attachments.js#L1350)  
> [自定义PDF resolvers](https://www.zotero.org/support/kb/custom_pdf_resolvers)  
> [Zotero中文社区相关信息](https://zotero-chinese.com/user-guide/plugins/Zotero-scihub.html#操作步骤)  

# 使用
下载并安装[最新版插件](https://github.com/syt2/zotero-scipdf/releases/latest/download/zotero-scipdf.xpi)。

- 对于安装插件前已经缺失附件的item，右键该item，点击`查找全文`即可
- 对于新增的带有`DOI`的条目，如果在首选项内勾选了`自动下载PDF`选项，则Zotero会自动尝试下载附件

### 增加/删除Sci-Hub站点
首次安装时插件会内置部分常用的Sci-Hub站点，若需要添加其他Sci-Hub站点，或删除已有Sci-Hub站点的，可以在插件的设置界面内编辑，不同的站点以`,`或`，`分割

# 常见问题
- OpenAlex 和 Sci-Hub 解析器都需要 `DOI`：Zotero 仅对带 DOI 的条目运行自定义 PDF 解析器。没有 DOI 的条目仍可通过 Zotero 自带的解析器（条目 URL / Zotero 的 OA 索引）尝试，但无法走这两个解析器。手动获取时，上述"缺失 DOI 补全"会先补上 DOI，使这两个解析器可用。
- 已经关联了附件的条目不显示`查找全文`选项；可用插件的右键菜单强制获取。
