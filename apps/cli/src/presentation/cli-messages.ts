/** Text owned by the CLI adapter; internal parser exceptions never become user messages. */
export const CLI_MESSAGES = Object.freeze({
  help: [
    '用法：',
    '  mas [--repo <路径>] [--readonly]                     交互式对话',
    '  mas run [--repo <路径>] [--readonly] "<目标>"        作为长任务完成一个目标',
    '  mas log [<对话>] [--repo <路径>] [--input <n>] [--full] [--json] [--list]',
    '                                                       查看一个对话的时间线（只读）',
    '',
    '选项：',
    '  --repo <路径>  本进程的仓库，缺省为当前工作目录',
    '  --readonly     只读预设：只允许安全级能力，项目指令文件一律不信任',
    '  -h, --help     显示帮助',
    '',
    'mas log：不带 <对话> 时看本仓库最近的一个；<对话> 可以是 --list 里的编号或对话 id。',
    '  --input <n>  只看第 n 次输入    --full  显示完整内容    --json  输出结构化结果    --list  列出本仓库的对话',
    '',
  ].join('\n'),
  run: '作为长任务完成一个目标，结束后退出',
  log: '查看一个对话的时间线',
  logSession: '列表里的编号、对话 id 或 id 的开头；缺省为本仓库最近的一个',
  logInput: '只看第 n 次输入',
  logFull: '显示完整内容',
  logJson: '输出结构化结果',
  logList: '列出本仓库的对话',
  repository: '本进程的仓库，缺省为当前工作目录',
  readonly: '只读预设',
  goal: '运行的目标',
  invalidArguments: '命令参数不符合要求，请检查命令格式。',
  errors: {
    'commander.unknownCommand': '无法识别该命令。',
    'commander.unknownOption': '无法识别该选项，请检查命令格式。',
    'commander.optionMissingArgument': '选项缺少必填参数。',
    'commander.missingArgument': '缺少模板或目标。',
    'commander.excessArguments': '命令参数过多，请将目标放在一组引号内。',
    'commander.invalidArgument': '选项的值不符合要求，--input 要给一个正整数。',
  } satisfies Record<string, string>,
});

export function parserErrorMessage(code: string): string {
  return Object.hasOwn(CLI_MESSAGES.errors, code)
    ? CLI_MESSAGES.errors[code as keyof typeof CLI_MESSAGES.errors]
    : CLI_MESSAGES.invalidArguments;
}
