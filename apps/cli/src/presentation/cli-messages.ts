/** Text owned by the CLI adapter; internal parser exceptions never become user messages. */
export const CLI_MESSAGES = Object.freeze({
  help: [
    '用法：',
    '  mas [--repo <路径>] [--readonly]                     交互式对话',
    '  mas run [--repo <路径>] [--readonly] <模板> "<目标>"  以模板运行一次（目前只有 analyze）',
    '',
    '选项：',
    '  --repo <路径>  本进程的仓库，缺省为当前工作目录',
    '  --readonly     只读预设：只允许安全级能力，项目指令文件一律不信任',
    '  -h, --help     显示帮助',
    '',
  ].join('\n'),
  run: '以模板运行一次，结束后退出',
  repository: '本进程的仓库，缺省为当前工作目录',
  readonly: '只读预设',
  template: '内置模板，例如 analyze',
  goal: '运行的目标',
  invalidArguments: '命令参数不符合要求，请检查命令格式。',
  unknownTemplate: (id: string) => `没有这个模板：${id}。`,
  errors: {
    'commander.unknownCommand': '无法识别该命令。',
    'commander.unknownOption': '无法识别该选项，请检查命令格式。',
    'commander.optionMissingArgument': '选项缺少必填参数。',
    'commander.missingArgument': '缺少模板或目标。',
    'commander.excessArguments': '命令参数过多，请将目标放在一组引号内。',
  } satisfies Record<string, string>,
});

export function parserErrorMessage(code: string): string {
  return Object.hasOwn(CLI_MESSAGES.errors, code)
    ? CLI_MESSAGES.errors[code as keyof typeof CLI_MESSAGES.errors]
    : CLI_MESSAGES.invalidArguments;
}
