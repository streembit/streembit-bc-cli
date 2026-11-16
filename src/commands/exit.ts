import { CommandDef } from '../cli/shell';
import { printLine } from '../cli/output';

export const exitCommand: CommandDef = {
    name: 'exit',
    summary: 'Exit the wallet.',
    handler: () => {
        printLine('Goodbye!');
        process.exit(0);
    },
};
