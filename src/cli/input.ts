/**
 * Common Input Utilities
 *
 * Provides reusable functions for handling user input in CLI commands
 * - Password input with hidden characters
 * - Text input with validation
 * - Retry loops for invalid input
 * - Confirmations
 */

import * as readline from 'node:readline';
import { StringDecoder } from 'node:string_decoder';

import { validatePassword as validatePasswordComplexity } from 'streembit-bc-sdk';
import { printError, toErrorMessage, EXIT_INTERRUPTED } from './output';
import { askShell } from './shell';

/**
 * Validator function type
 * Returns true if input is valid, or an error message if invalid
 */
export type InputValidator = (input: string) => boolean | string;

/** The listeners taken off standard input for the time of the hidden prompt and put back after it: one for 'data', which gets the chunk, and one for 'readable' and 'end', which get nothing */
type DataListener = (chunk: Buffer | string) => void;
type SignalListener = () => void;

/** How long the rest of a terminal escape sequence may take to arrive; readline's own default (escapeCodeTimeout) */
const ESCAPE_SEQUENCE_TIMEOUT_MS = 500;

/** True when a person can type: standard input is a terminal. A script or a service runs without one. */
export function hasTerminal(): boolean {
    return process.stdin.isTTY === true;
}

/** True when a person reads the answer: standard output is a terminal, not a file or a pipe. A recovery phrase is shown only there. */
export function hasScreen(): boolean {
    return process.stdout.isTTY === true;
}

/**
 * Core function to get raw input from user (hidden or visible)
 * @param promptText - The prompt to display
 * @param hideInput - Whether to hide the input (for passwords)
 * @returns The user's input
 */
async function getRawInput(promptText: string, hideInput: boolean = false): Promise<string> {
    if (!hideInput) {
        // Inside the shell the question is asked through the shell's readline: a second readline on the same
        // input would give the answer to the shell as well, which would run it as a command
        const asked = askShell(promptText);
        if (asked) {
            return asked;
        }
        // One-shot mode: no shell is running, the question gets its own readline
        return new Promise((resolve, reject) => {
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
            });
            let answered = false;

            // Ctrl+C at the question abandons the command: the run ends as interrupted, never as a success
            rl.on('SIGINT', () => {
                process.stdout.write('\n');
                process.exit(EXIT_INTERRUPTED);
            });
            // The input ended (Ctrl+D, or a closed pipe) before an answer came: the command fails, it does not end silently
            rl.on('close', () => {
                if (!answered) {
                    reject(new Error('No answer: the input ended'));
                }
            });

            rl.question(promptText, (answer) => {
                answered = true;
                rl.close();
                resolve(answer);
            });
        });
    }
    else {
        // Silent input (no echo to screen)
        return new Promise((resolve, reject) => {
            const stdin = process.stdin;
            const stdout = process.stdout;

            // Check for TTY before anything is written
            if (!stdin.isTTY) {
                reject(new Error('No terminal to type the password on'));
                return;
            }

            // Write the prompt
            stdout.write(promptText);

            let input = '';
            const wasRaw = stdin.isRaw;

            // Remove ALL existing listeners from stdin first
            const existingDataListeners = stdin.listeners('data') as DataListener[];
            const existingReadableListeners = stdin.listeners('readable') as SignalListener[];
            const existingEndListeners = stdin.listeners('end') as SignalListener[];

            // Remove all listeners temporarily
            stdin.removeAllListeners('data');
            stdin.removeAllListeners('readable');
            stdin.removeAllListeners('end');

            // Set to raw mode
            stdin.setRawMode(true);
            stdin.resume();

            const cleanup = () => {
                stdin.removeListener('data', onData);

                // Restore raw mode based on previous state
                stdin.setRawMode(!!wasRaw);

                // Restore original listeners before resuming
                existingDataListeners.forEach(listener => stdin.on('data', listener));
                existingReadableListeners.forEach(listener => stdin.on('readable', listener));
                existingEndListeners.forEach(listener => stdin.on('end', listener));

                if (wasRaw) {
                    stdin.resume();
                } else {
                    stdin.pause();
                }
            };

            // A chunk is one key or a whole paste; the decoder keeps a character whose bytes arrive in two chunks together
            const decoder = new StringDecoder('utf8');

            // A terminal escape sequence (an arrow or a function key) is not part of the password. Its characters can
            // arrive in two chunks, so the place inside the sequence is kept between chunks: 'escape' after ESC,
            // 'csi' after ESC [ until the final character, 'ss3' after ESC O for one character. An ESC that nothing
            // follows within the time readline also allows is the Esc key alone, and what is typed later is password.
            let sequence: 'none' | 'escape' | 'csi' | 'ss3' = 'none';
            let sequenceTime = 0;

            const onData = (chunk: Buffer | string) => {
                const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
                if (sequence !== 'none' && Date.now() - sequenceTime > ESCAPE_SEQUENCE_TIMEOUT_MS) {
                    sequence = 'none';
                }

                // Character by character, so that a pasted password is taken in full and Enter, Ctrl+C and Backspace work inside a chunk
                for (const char of text) {
                    if (char === '\u001b') {
                        sequence = 'escape';
                        sequenceTime = Date.now();
                        continue;
                    }
                    if (sequence === 'escape') {
                        // ESC [ opens a control sequence, ESC O a function key; ESC with any other character is that key with Alt
                        sequence = char === '[' ? 'csi' : char === 'O' ? 'ss3' : 'none';
                        continue;
                    }
                    if (sequence === 'ss3') {
                        sequence = 'none';
                        continue;
                    }
                    if (sequence === 'csi') {
                        // Parameter and intermediate characters run up to the final one, '@' to '~'
                        if (char >= '@' && char <= '~') {
                            sequence = 'none';
                        }
                        continue;
                    }
                    if (char === '\r' || char === '\n') {
                        // Enter ends the input; what follows it in the chunk, the line feed of a paste, is dropped
                        cleanup();
                        stdout.write('\n');
                        resolve(input);
                        return;
                    }
                    if (char === '\u0003') {
                        // Ctrl+C abandons the command: the run ends as interrupted, never as a success
                        cleanup();
                        stdout.write('\n');
                        process.exit(EXIT_INTERRUPTED);
                    }
                    if (char === '\u007f' || char === '\b') {
                        // Backspace removes one whole character
                        const characters = Array.from(input);
                        if (characters.length > 0) {
                            input = characters.slice(0, -1).join('');
                            stdout.write('\b \b');
                        }
                        continue;
                    }
                    if (char < ' ') {
                        // Any other control character is ignored
                        continue;
                    }
                    // Printable character, of any alphabet: the wallet file's password is not limited to ASCII
                    input += char;
                    stdout.write('*');
                }
            };

            stdin.on('data', onData);
        });
    }
}

/**
 * Prompt for text input with optional validation
 * @param promptText - The prompt to display
 * @param validator - Optional validation function
 * @returns The validated input
 */
export async function promptText(promptText: string, validator?: InputValidator): Promise<string> {
    let input: string;
    let isValid = false;

    // Only an answer the validator refuses is asked again; an input that cannot be read at all is thrown, never retried
    while (!isValid) {
        input = await getRawInput(promptText, false);

        if (validator) {
            const result = validator(input);
            if (result === true) {
                isValid = true;
            } else {
                printError(typeof result === 'string' ? result : 'Invalid input');
                console.log('Please try again.\n');
            }
        } else {
            isValid = true;
        }
    }

    return input!;
}

/**
 * Prompt for password input with optional validation
 * @param prompt - The prompt to display
 * @param validator - Optional validation function
 * @returns The validated password
 */
export async function promptPassword(prompt: string = 'Enter password: ', validator?: InputValidator): Promise<string> {
    let password: string;
    let isValid = false;

    // Only a password the validator refuses is asked again; without a terminal the input cannot be read and that is thrown, never retried
    while (!isValid) {
        password = await getRawInput(prompt, true); // Use raw mode approach

        if (validator) {
            const result = validator(password!);
            if (result === true) {
                isValid = true;
            } else {
                printError(typeof result === 'string' ? result : 'Invalid password');
                console.log('Please try again.\n');
            }
        } else {
            isValid = true;
        }
    }

    return password!;
}

/**
 * Prompt for password with complexity requirements
 * Shows requirements and validates against them
 * @param confirmPrompt - Optional custom prompt for confirmation
 * @returns The validated password
 */
export async function promptPasswordWithRequirements(confirmPrompt: string = 'Confirm password: '): Promise<string> {
    // Show password requirements
    console.log('\nPassword requirements:');
    console.log('  - Minimum 12 characters');
    console.log('  - At least one lowercase letter (a-z)');
    console.log('  - At least one uppercase letter (A-Z)');
    console.log('  - At least one number (0-9)');
    console.log('  - At least one special character (!@#$%^&*() etc.)\n');

    let password: string;
    let passwordConfirmed = false;

    while (!passwordConfirmed) {
        // Get password with complexity validation
        password = await promptPassword('Enter password: ', (pwd) => {
            const validation = validatePasswordComplexity(pwd);
            return validation.isValid || validation.error || 'Invalid password';
        });

        // Get confirmation
        const confirmation = await promptPassword(confirmPrompt);

        if (password === confirmation) {
            passwordConfirmed = true;
        } else {
            printError('Passwords do not match');
            console.log('Please try again.\n');
        }
    }

    return password!;
}

/**
 * Prompt for yes/no confirmation
 * @param message - The confirmation message
 * @param defaultValue - Default value if user just presses enter
 * @returns true for yes, false for no
 */
export async function promptConfirm(message: string, defaultValue: boolean = false): Promise<boolean> {
    const defaultText = defaultValue ? '[Y/n]' : '[y/N]';
    const promptText = `${message} ${defaultText}: `;

    try {
        const input = await getRawInput(promptText, false);

        if (input === '') {
            return defaultValue;
        }

        const normalized = input.toLowerCase().trim();
        return normalized === 'y' || normalized === 'yes';
    } catch (err) {
        printError(`Input error: ${toErrorMessage(err)}`);
        return defaultValue;
    }
}
