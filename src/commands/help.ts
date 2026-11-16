import { CommandDef, listCommands } from '../cli/shell';
import { printLine } from '../cli/output';

export const helpCommand: CommandDef = {
    name: 'help',
    summary: 'Show available commands and usage.',
    handler: () => {
        const rows = listCommands().map((c) => {
            const usage = c.usage ? `\n    usage: ${c.usage}` : '';
            return `  ${c.name.padEnd(18)} - ${c.summary}${usage}`;
        });
        printLine('\nCommands:\n' + rows.join('\n') + '\n');
    },
};
