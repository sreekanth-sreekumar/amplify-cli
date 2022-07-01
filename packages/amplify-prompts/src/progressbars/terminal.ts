/* eslint-disable spellcheck/spell-checker */
/* eslint-disable indent */
/* eslint-disable jsdoc/require-jsdoc */

import readline from 'readline';

export class AmplifyTerminal {
    private dy: number;
    private linewrap: boolean;
    private stream: NodeJS.WriteStream;

    constructor() {
        this.stream = process.stdout;
        this.dy = 0;
        this.linewrap = true;
    }

    // Check if the write stream is tty
    isTTY(): boolean {
        return (this.stream.isTTY === true);
    }

    // Save current cursor position
    saveCursor(): void {
        if (!this.isTTY()) {
            return;
        }
        this.stream.write('\x1B7');
    }

    // Restore last saved cursor position
    restoreCursor(): void {
        if (!this.isTTY()) {
            return;
        }
        this.stream.write('\x1B8');
    }

    // Show/Hide cursor
    cursor(enabled: boolean) : void {
        if (!this.isTTY()) {
            return;
        }
        if (enabled) {
            this.stream.write('\x1B[?25h');
        } else {
            this.stream.write('\x1B[?25l');
        }
    }

    // Move cursor position
    moveCursor(x : number, y : number) : void {
        if (!this.isTTY()) {
            return;
        }
        readline.cursorTo(this.stream, x, y);
    }

    // Move cursor position relative
    moveCursorRelative(dx: number, dy: number) : void {
        if (!this.isTTY()) {
            return;
        }

        // store current position
        this.dy += dy;
        // move cursor relative
        readline.moveCursor(this.stream, dx, dy);
    }

    // reset the cursor to the begining of the current line
    cursorRelativeReset(): void {
        if (!this.stream.isTTY) {
            return;
        }

        // move cursor to beginning of the current line
        readline.moveCursor(this.stream, 0, -this.dy);

        // first char
        readline.cursorTo(this.stream, 0, undefined);

        // reset counter
        this.dy = 0;
    }

    // Clear the current line to the right
    clearRight() :void {
        if (!this.isTTY()) {
            return;
        }

        readline.clearLine(this.stream, 1);
    }

    // clear the full line
    clearLine() : void {
        if (!this.isTTY()) {
            return;
        }

        readline.clearLine(this.stream, 0);
    }

    // clear everyting beyond the current line
    clearBottom() : void {
        if (!this.isTTY()) {
            return;
        }
        readline.clearScreenDown(this.stream);
    }

    // add new line; increment counter
    newLine() : void {
        this.stream.write('\n');
        this.dy++;
    }

    // write content to output stream
    write(s :string, rawWrite = false) : void {
        // line wrapping enabled ? trim output
        if (this.linewrap === true && rawWrite === false) {
            this.stream.write(s.substr(0, this.getWidth()));
        } else {
            this.stream.write(s);
        }
    }

    // control line wrapping
    lineWrapping(enabled : boolean) : void {
        if (!this.isTTY()) {
            return;
        }

        // store state
        this.linewrap = enabled;
        if (enabled) {
            this.stream.write('\x1B[?7h');
        } else {
            this.stream.write('\x1B[?7l');
        }
    }

    // get terminal width
    getWidth() : number {
        // set max width to 80 in tty-mode and 200 in notty-mode
        return this.stream.columns || (this.stream.isTTY ? 80 : 200);
    }
}
