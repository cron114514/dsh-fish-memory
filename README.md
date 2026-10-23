# dsh-fish-memory

金鱼记忆：记得住，但**会忘**。

大多数「记忆插件」都在加东西——加向量库、加摘要、加检索。这个反着来：每条记忆有初始权重和 TTL，权重按半衰期衰减，过期就是真的忘了；提示词里只出现当前最重的那几条。于是 agent 的「记性」变成一个随时间变化的量，而不是一个只增不减的数据库。

- 零运行时依赖，host 插件。
- 提示词上下文里只放活着的、最重的 N 条，空记忆时整段不注入。
- 四个工具：记、查、忘、看状态。

## 衰减规则

| 规则 | 默认 |
| --- | --- |
| 权重半衰期 | `25` 分钟（`w=0.9` 过 25 分钟变 `0.45`） |
| 默认 TTL | `90` 分钟（到点直接算忘了） |
| 数量和上限 | `200` 条，塞满先淘汰最轻的 |
| 注入条数 | 最重的 `5` 条 |

## 安装

```powershell
git clone https://github.com/<you>/dsh-fish-memory "$env:USERPROFILE\.dsh\plugins\dsh-fish-memory"
cd "$env:USERPROFILE\.dsh\profiles\desktop"
# package.json：dependencies 加 "dsh-fish-memory": "link:../../plugins/dsh-fish-memory"
#              dsh.profile.bundles 加 "dsh-fish-memory"
pnpm install
# 重启 DeepSeek Harness
```

## 配置

```yaml
- insert:
    - id: fish-memory
      name: dsh-fish-memory
      config:
        halfLifeMinutes: 25
        defaultTtlMinutes: 90
        maxEntries: 200
        promptLimit: 5
        promptOrder: 9070
        promptMaxChars: 900
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 关掉后不注册 |
| `halfLifeMinutes` | `25` | 权重衰减一半所需时间 |
| `defaultTtlMinutes` | `90` | 没写 TTL 时的默认寿命 |
| `maxEntries` | `200` | 最多存多少条 |
| `promptLimit` | `5` | 注入几条；`0` 表示完全不注入 |
| `promptOrder` | `9070` | 提示词排序 |
| `promptMaxChars` | `900` | 注入文本上限 |
| `statePath` | — | 覆盖状态文件位置 |

## 工具

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `fish_memorize` | `text`（必填）、`tags`、`ttlMinutes`、`weight` | 记一条短信息 |
| `fish_recall` | `query`、`limit` | 按关键词翻；不传 `query` 就按权重取 |
| `fish_forget` | `id` 或 `all: true` | 忘掉一条 / 全部 |
| `fish_status` | — | 条数、最重一条、最早多久前、累计命中 |

## 状态

`<DSH_HOME>/plugin-data/dsh-fish-memory/state.json`：

```json
{
  "version": 1,
  "entries": [
    {
      "id": "9f2c1a4b",
      "text": "用户周末要去钓鱼",
      "tags": ["安排"],
      "weight": 0.8,
      "createdAt": 1761300000000,
      "ttlMinutes": 90,
      "hits": 1
    }
  ]
}
```

## 开发

```powershell
node --test
```

## License

MIT
