/**
 * WebUI 插件设置页里的「看片与打字」配置组（cortico World 配置组契约）。
 *
 * 契约（见 cortico/src/extensions/dry-mount.ts:47-63 与 core/config-schema.ts）：
 *   - 属性键必须是 `worlds.stage.*` 点分路径，写回 config.json 时按路径落进 worlds.stage 段；
 *   - 每个声明的键都必须在 DEFAULT_CONFIG（defaults()）里有对应项，否则 dry-mount 会警告；
 *   - `x-hot: true` = 改完立即生效（world 重启或被热更新）；`x-hot: false` = 需重启世界/应用。
 *
 * 这里只放数值/布尔旋钮；开关文案直接决定世界行为，改它们不用改代码。
 */
export function stageConfigGroup(language) {
  const zh = language !== 'en';
  const t = (z, e) => (zh ? z : e);
  const P = 'worlds.stage.';

  const title = t('看片与打字', 'Watch & Type');
  const group = {
    id: 'world:stage',
    owner: 'world:stage',
    schema: {
      type: 'object',
      title,
      description: t(
        '控制 Coo 的「看片与打字」世界：感知开关、事件冷却和截图参数。数值类改完即生效；改端口需重启世界。',
        'Controls the Watch & Type world: sensing switches, event cooldowns and screenshot options. Numbers apply immediately; changing the port requires a world restart.',
      ),
      properties: {
        [`${P}watchEnabled`]: {
          type: 'boolean',
          title: t('对「用户看视频」做反应', 'React to user watching video'),
          description: t(
            '默认关。开启后，检测到用户在浏览器放视频时推 stage.watch 事件（她自己看视频的姿势不依赖这个开关）。',
            'Off by default. When on, emits stage.watch when the user plays a video in a browser.',
          ),
          'x-hot': true,
        },
        [`${P}typingEnabled`]: {
          type: 'boolean',
          title: t('对「用户打字」做反应', 'React to user typing'),
          description: t(
            '默认关。开启后，检测到用户在输入框连续打字时推 stage.typing 事件（每段会话只推一条）。',
            'Off by default. When on, emits stage.typing once per typing session.',
          ),
          'x-hot': true,
        },
        [`${P}videoCooldownSec`]: {
          type: 'integer',
          title: t('视频事件冷却', 'Video event cooldown'),
          description: t('同一视频重复推 stage.watch 的最短间隔。', 'Minimum gap between repeated stage.watch events for the same video.'),
          minimum: 10,
          maximum: 3600,
          'x-suffix': 's',
          'x-hot': true,
        },
        [`${P}typingCooldownSec`]: {
          type: 'integer',
          title: t('打字事件冷却', 'Typing event cooldown'),
          description: t('两段打字会话之间至少间隔多久才再推 stage.typing。', 'Minimum gap between two typing sessions before a new stage.typing is emitted.'),
          minimum: 5,
          maximum: 600,
          'x-suffix': 's',
          'x-hot': true,
        },
        [`${P}titleCooldownSec`]: {
          type: 'integer',
          title: t('换视频标题冷却', 'Title-change cooldown'),
          description: t('浏览器标题变化（换视频、标题抖动）后重新推事件的最短间隔。', 'Minimum gap before re-emitting after the browser title changes.'),
          minimum: 5,
          maximum: 600,
          'x-suffix': 's',
          'x-hot': true,
        },
        [`${P}pollMs`]: {
          type: 'integer',
          title: t('采样间隔', 'Sampling interval'),
          description: t('后台多久采一次前台窗口（毫秒）。太小费 CPU，太大反应慢。', 'How often to sample the foreground window, in ms.'),
          minimum: 200,
          maximum: 5000,
          'x-suffix': 'ms',
          'x-hot': true,
        },
        [`${P}probePort`]: {
          type: 'integer',
          title: t('本地探针端口', 'Local probe port'),
          description: t(
            '127.0.0.1 上的只读探针（GET /probe）；0 = 关闭。默认 19388，避开 7797/17788/19387/9223/3517。改端口需重启世界。',
            'Read-only local probe on 127.0.0.1 (GET /probe); 0 = off. Changing it requires a world restart.',
          ),
          minimum: 0,
          maximum: 65535,
          'x-hot': false,
        },
        [`${P}screenshot.maxWidth`]: {
          type: 'integer',
          title: t('截图最大宽度', 'Screenshot max width'),
          description: t('stage_locate 截图的缩放上限（像素，0 = 原尺寸）。只影响本地日志里的 PNG。', 'Max width of stage_locate screenshots in px (0 = original).'),
          minimum: 320,
          maximum: 3840,
          'x-suffix': 'px',
          'x-hot': true,
        },
        [`${P}screenshot.quality`]: {
          type: 'integer',
          title: t('截图质量', 'Screenshot quality'),
          description: t('保留参数：当前 PNG 无损编码，质量暂不生效（留给未来的 JPEG 用）。', 'Reserved: current PNG encoder is lossless; quality has no effect yet.'),
          minimum: 10,
          maximum: 100,
          'x-hot': true,
        },
        [`${P}screenshot.format`]: {
          type: 'string',
          title: t('截图格式', 'Screenshot format'),
          description: t('当前固定 PNG（无损，纯 JS 编码，不依赖 PowerShell）。', 'Currently always PNG (lossless, pure JS encoder).'),
          enum: ['png'],
          'x-hot': true,
        },
      },
    },
  };
  return group;
}
