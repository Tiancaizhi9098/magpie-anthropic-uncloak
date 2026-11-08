# Magpie Anthropic Uncloak

Magpie 的 Anthropic API 供应商插件，提供 CPA 风格的 uncloak 处理，无需另开 CPA 服务。

## 安装

```bash
magpie plugin add github:Tiancaizhi9098/magpie-anthropic-uncloak
magpie plugin login anthropic-uncloak
```

1. 填入领取赠金的 Claude Console 组织创建的 API Key，推荐使用限定到 Workspace 的 Key。
2. 在 Magpie 的「Agent → Claude Code」中选择 **Anthropic Uncloak** 下的模型。
3. 重新打开 Claude Code 会话。

需要开启 Magpie「设置 → 隐私 → 订阅账号」。Bun 需支持无损 JSON；已验证 Magpie v0.1.3337 / Bun 1.4.2（Windows x64）。

已通过 43 项测试和 7 项本地集成检查。**真实赠金抵扣尚未实测，以 Console 账单为准。**

## 开发

```bash
npm test
npm run check
```

MIT License。实现参考 [CPA uncloak](https://github.com/router-for-me/CLIProxyAPI/issues/6762) 和 [Magpie 插件接口](https://usemagpie.ai/docs/plugins#requests)。
