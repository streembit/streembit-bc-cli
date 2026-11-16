/**
 * Command-line argument parsing utilities
 */

/**
 * Parse command line arguments into positional arguments and options
 * @param args - Array of command line arguments
 * @returns Object containing positional arguments and options map
 *
 * @example
 * parseArgs(['file.txt', '--output', 'result.json', '--verbose'])
 * // Returns: {
 * //   positional: ['file.txt'],
 * //   options: Map { 'output' => 'result.json', 'verbose' => 'true' }
 * // }
 */
export function parseArgs(args: string[]): { positional: string[], options: Map<string, string> } {
    const positional: string[] = [];
    const options = new Map<string, string>();

    for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith('--')) {
            const [flag, inlineValue] = args[i].substring(2).split('=', 2);
            if (inlineValue !== undefined) {
                options.set(flag, inlineValue);
            } else if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
                options.set(flag, args[i + 1]);
                i++; // Skip next arg as it's the value
            } else {
                options.set(flag, 'true'); // Flag without value
            }
        } else {
            positional.push(args[i]);
        }
    }

    return { positional, options };
}
