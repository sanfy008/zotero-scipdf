# SciPDF for Zotero

[English](../README.md) | 简体中文

SciPDF 为 Zotero 7–10 查找全文 PDF，并补齐缺失的文献元数据。请安装[最新版 XPI](https://github.com/syt2/zotero-scipdf/releases/latest/download/sci-pdf.xpi)。

## 条目右键菜单

- **获取 PDF**：按设置校验或修复 DOI，尝试复用库内 PDF，再查找已启用的开放获取来源（arXiv、Unpaywall、Semantic Scholar、OpenAlex）。Sci-Hub 是可选兜底，**默认关闭**。未能添加 PDF 时，可按设置补齐元数据。
- **校验并修复 DOI**：检查 DOI 是否存在、是否属于当前条目。缺失或明确不匹配时，结合可用的标题、作者和年份寻找替代 DOI。无法确定时保留原值。
- **补齐元数据与摘要**：仅补写空字段，不覆盖已有内容。若已开启 DOI 修复，也会先校验 DOI。

库内复用添加的是链接附件，不会再存一份文件。Zotero 不同步链接文件的内容，群组库不支持此类附件。移动或删除原文件可能导致链接失效。

## Zotero 原生查找是另一条路径

Zotero 的**查找可用的 PDF**和新条目的自动查找走原生流程。SciPDF 为启用的 OpenAlex 和 Sci-Hub 提供[基于 DOI 的自定义解析器](https://www.zotero.org/support/kb/custom_pdf_resolvers)。原生流程不会运行 SciPDF 的 DOI 修复、库内复用或元数据补齐。

在 SciPDF 首选项中可以配置来源，以及是否让自定义解析器参与自动查找。Sci-Hub 镜像地址用逗号分隔；清空列表后不会请求任何镜像。
