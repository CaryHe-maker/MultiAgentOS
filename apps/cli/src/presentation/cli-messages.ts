/** Text owned by the CLI adapter; internal parser exceptions never become user messages. */
export const CLI_MESSAGES = Object.freeze({
  help: [
    '用法：multiagentos analyze --repo <绝对路径> [--details] "<目标>"',
    '',
    '以只读方式分析仓库，显示带来源的分析报告。',
    '',
    '选项：',
    '  --repo <绝对路径>  要分析的仓库目录（必填）',
    '  --details          同时显示运行摘要',
    '  -h, --help         显示帮助',
    '',
  ].join('\n'),
  analyze: '以只读方式分析仓库并显示带来源的报告',
  repository: '仓库的绝对路径',
  details: '同时显示运行摘要',
  goal: '需要分析的目标',
  absolutePath: '--repo 必须是绝对路径。',
  invalidArguments: '命令参数不符合要求，请检查命令格式。',
  errors: {
    'commander.unknownCommand': '无法识别该命令，请使用 analyze。',
    'commander.unknownOption': '无法识别该选项，请检查命令格式。',
    'commander.missingMandatoryOptionValue': '缺少必填的 --repo 仓库路径。',
    'commander.optionMissingArgument': '选项缺少必填参数。',
    'commander.missingArgument': '缺少必填的分析目标或命令参数。',
    'commander.excessArguments': '命令参数过多，请将分析目标放在一组引号内。',
  } satisfies Record<string, string>,
});

export function parserErrorMessage(code: string): string {
  return Object.hasOwn(CLI_MESSAGES.errors, code)
    ? CLI_MESSAGES.errors[code as keyof typeof CLI_MESSAGES.errors]
    : CLI_MESSAGES.invalidArguments;
}
