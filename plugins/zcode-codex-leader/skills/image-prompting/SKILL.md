---
name: image-prompting
description: 图像生成命中率提升。当任务涉及生图、图像生成、generate image、图片、海报、插画、logo、视觉资产、改图、图生图时加载。教 leader 用叙事式 prompt、改图优先、多轮迭代、参考图角色一致性提升 Gemini 3 Pro Image 命中率。不触发代码截图/UI 截图分析(那用 vision)。
---

# 图像提示词

本技能只面向本地 Gemini 3 Pro Image 的对话式接口: 通过 `codex_bridge.ts agy` 后端或 `codex_bridge.ts generate-image` 命令生图。不要混入 Vertex AI Imagen 接口事实；`negative_prompt` 参数和精确出图数量控制不适用于这里。

## 何时加载本技能

任务涉及生图、图像生成、generate image、图片、海报、插画、logo、视觉资产、改图、图生图时加载。

不要在代码截图、UI 截图、截图分析、视觉理解任务中加载本技能；那类任务使用 `vision`。

## 核心原则:描述场景,不堆关键词(官方首要原则)

Gemini 官方原话:"Describe the scene, do not just list keywords. A narrative, descriptive paragraph almost always produces better, more coherent images than a list of disconnected words."

对比示例:

- 低命中(标签堆砌): masterpiece, 8k, photorealistic, cinematic lighting, old fisherman
- 高命中(叙事描述): A close-up portrait of a weathered 70-year-old fisherman with deep wrinkles, staring into the camera. He wears a yellow vinyl raincoat with soft raindrops. Background is a blurry harbor at dusk. Dramatic side lighting from a single street lamp, cool blue palette.

执行时先把用户的短需求改写成一段可视化叙事，再交给后端。不要把 Stable Diffusion 式标签串当作最终 prompt。

## 结构化叙事 prompt 模板

用自然语言叙述每一段，不写 SD 式标签:

`[主体在做什么] + [环境场景] + [艺术风格] + [构图/镜头] + [光线] + [色调] + [细节材质]`

按重要性从左到右写，最核心的主体、动作、画面意图放最前面。删除冗余修饰词，例如 `extremely`、`beautiful`、`amazing`。

可直接使用这个骨架:

```text
A [subject] is [action] in [environment]. The image is rendered as [art style]. The composition uses [camera/composition], with [lighting]. The color palette is [color palette]. Important visible details include [materials, texture, props, facial expression, clothing].
```

中文任务可以中文写，但视觉细节、镜头词、固定文字可保留英文，避免含糊表达。

## 没有负面提示参数——用语义负面提示(官方)

Gemini 对话接口没有 `negative_prompt` 参数。Vertex AI Imagen 接口有该参数，但本地使用 Gemini 对话式接口，不适用。

官方做法是用正向描述替代 `no X`:

- 错: no cars, no people
- 对: an empty, deserted street with no signs of traffic

写 prompt 时把不想出现的东西改成画面状态。例如把“不要拥挤”改为“a quiet lobby with wide open floor space and only one receptionist behind the desk”。

## 改图优先:图生图比文生图命中率高一个量级(四路共识)

最大命中率杠杆是给模型参考图。有参考图、草图、线稿、截图、品牌图、角色图时，优先用 `input_image` 或通过 `agy` 后端把图片路径和要求一起交给模型，不要从零文生图。

Gemini 支持的高价值改图路径:

- 背景替换: 保留主体，替换背景。
- Inpainting 局部重绘: 只改手、脸、文字、局部道具或瑕疵区域。
- Outpainting 向外延展: 把窄图延展成横版、竖版或更大画幅。
- 风格迁移: 保留构图和主体，把风格转成海报、插画、3D、摄影等。
- 草图转成品: 用线稿、涂鸦、产品草图生成完整视觉资产。

Leader 判断规则: 用户提供了图片，默认走改图/图生图；用户只提供文字且没有素材，才走纯文生图。

## 多轮对话迭代,不是一次性抽卡(官方)

Gemini 对话接口没有可靠的 count 参数。官方说明:"will not always follow the exact number of image outputs requested"。

不要指望一次请求稳定生成 4 张再选最好。更可靠的流程是:

1. 先生成一张命中主体和构图的版本。
2. 如果不满意，用自然语言跟进。
3. 只改一个主要维度，保留其余画面。

可用跟进语:

- `make the lighting warmer`
- `keep everything but change the expression`
- `keep the composition and outfit, but make the background a rainy evening street`
- `only fix the text on the sign; preserve the rest of the image`

多轮改动通常比重新抽卡命中率更高。

## 角色一致性:参考图注入,不是 session_id 魔法

`session_id` 管多轮对话上下文，这是上下文连续性，不是原生锁脸参数。不要把它当成角色一致性魔法。

真正的角色一致性靠三件事:

- 参考图注入: Gemini 3 Pro Image 最多 14 张参考图，其中角色一致性 5 张、物体高保真 6 张、风格 3 张。
- Master Identity Spec: 把角色特征写成固定块，每次贴在 prompt 最前面。
- prompt 分块隔离: `[角色特征块] in [场景动作块]`，避免动作词污染相貌。

Master Identity Spec 示例:

```text
Master Identity Spec: The same young woman has a round face, short black bob haircut with straight bangs, warm brown eyes, a small mole under her left eye, and a calm confident expression. Keep these identity traits consistent in every image.

Scene: She is standing at a night-market food stall, holding a paper cup of tea, with warm lantern light and shallow depth of field.
```

## aspect_ratio 生成时指定,不要生成后裁剪(官方)

Gemini 有构图推理机制，会按 `aspect_ratio` 在初始化阶段规划构图。先生成 `1:1` 再裁成 `16:9` 会破坏构图。

生成前就指定目标比例，并配匹配视角词:

- `16:9`: cinematic wide-angle, horizontal composition, environmental context
- `9:16`: full-body portrait, low angle, vertical poster composition
- `1:1`: centered composition, balanced square frame
- `21:9`: ultra-wide establishing shot, panoramic composition

支持比例: `1:1`、`2:3`、`3:2`、`3:4`、`4:3`、`4:5`、`5:4`、`9:16`、`16:9`、`21:9`。

## 常见失败规避表

| 失败 | 规避 | 可信度 |
|---|---|---|
| 文字乱码 | 双引号锁定文字 `"OPEN LATE"` + 描述物理载体(霓虹灯箱/木牌) + ≤25字符 + 文字命令放 prompt 前部 | 官方 |
| 手指畸形 | 指定简单手势(`hands in pockets`) + 半身像减少手外露 + 出错用 inpainting 局部重绘 | 社区经验 |
| 风格漂移 | `"standing in stark contrast with"` 隔离主体与背景 + prompt 开头统一风格前缀 | 社区经验 |
| 主体偏离 | 删冗余修饰词 + 按重要性从左到右写 | 社区经验 |
| 手指/解剖 | 模型固有限制，无法靠 prompt 彻底解决，只能规避或局部重绘 | 硬伤 |

## 两个生图后端的选择

- `codex_bridge.ts generate-image`: 走 codex worker 的 `image_generation_call`。适合简单单张文生图，参数少，交互成本低。
- `codex_bridge.ts agy "生成图片的 prompt..." --model "Gemini 3.1 Pro (High)"`: 走 Antigravity CLI。适合 Gemini 3 Pro Image 的复杂任务，参数最全，更适合参考图、改图、多轮迭代、`session_id` 语义上下文。

选择规则:

- 要参考图、改图、局部修复、角色一致性或多轮迭代: 用 `agy` 后端。
- 只要简单单张、没有参考图、没有连续上下文: `generate-image` 也可。
- 需要分析代码截图或 UI 截图: 不要用本技能，改用 `vision`。

## 模型固有限制(诚实标注)

- 无 seed 参数，无法确定性复现同一张图。
- 无可靠 count，不能保证一次出 N 张。
- 无透明背景支持。
- 手指/精细解剖是硬伤。
- 所有生成图带 SynthID 水印。

遇到这些限制时要直说，不要承诺可用 prompt 完全解决。

## 用法示例

简单单张文生图:

```bash
node --experimental-strip-types plugins/zcode-codex-leader/scripts/codex_bridge.ts generate-image "A compact civic-service poster showing a warm public reception desk inside a bright campus hall. The composition is a clean 4:5 vertical poster, soft peach and blue palette, natural daylight, readable sign text \"SERVICE DAY\" on a small acrylic desk sign." --out ./outputs/service-day.png
```

用 `agy` 走 Gemini 3.1 Pro Image，高规格生成:

```bash
node --experimental-strip-types plugins/zcode-codex-leader/scripts/codex_bridge.ts agy "使用 Gemini 3 Pro Image 生成一张 16:9 横版图: A weathered 70-year-old fisherman is staring into the camera at a blurry harbor at dusk. He wears a yellow vinyl raincoat with soft raindrops. Dramatic side lighting from a single street lamp, cool blue palette, close-up portrait, realistic documentary photography. aspect_ratio: 16:9" --model "Gemini 3.1 Pro (High)" --timeout 20m
```

参考图/改图优先:

```bash
node --experimental-strip-types plugins/zcode-codex-leader/scripts/codex_bridge.ts agy "使用参考图 ./refs/character.png 保持同一角色身份。Master Identity Spec: same face shape, same short black bob haircut, same mole under the left eye, same calm confident expression. Scene: place her in a rainy neon bookstore at night, holding a red umbrella, cinematic 9:16 full-body portrait. 只改变场景和服装氛围，保持角色脸部一致。" --model "Gemini 3.1 Pro (High)" --add-dir ./refs --timeout 20m
```
