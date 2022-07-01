/* eslint-disable no-lonely-if */
/* eslint-disable @typescript-eslint/naming-convention */
/* eslint-disable prefer-template */
/* eslint-disable spellcheck/spell-checker */
/* eslint-disable comma-dangle */
/* eslint-disable indent */
/* eslint-disable no-trailing-spaces */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable jsdoc/require-jsdoc */
import { AmplifyTerminal as Terminal } from './terminal';
import { ProgressBar as Bar } from './progress-bar';

export type barOptions = {
    progressBarFormatter: (params: any, payload: any) => string,
    itemFormatter: (payload: any) => string,
    loneWolf: boolean,
    hideCursor: boolean,
    lineWrap: boolean,
    barCompleteChar: string,
    barIncompleteChar : string,
    barSize: number,
    itemCompleteStatus: string[],
    itemFailedSubString: string
}

export class MultiProgressBar {
    private count : number;
    private terminal : any;
    private options : barOptions;
    private bars : any[];
    private lastDrawnString: string;
    private lastDrawnTime: number;
    isActive: boolean;

    constructor(options : barOptions) {
        this.terminal = new Terminal();
        this.options = options;
        this.bars = [];
        this.terminal.saveCursor();
        
        if (this.options.hideCursor === true) {
            this.terminal.cursor(false);
        }

        if (this.options.lineWrap === false) {
            this.terminal.lineWrapping(false);
        }
        this.lastDrawnString = '';
        this.lastDrawnTime = Date.now();
        this.isActive = false;
        this.count = 0;
    }

    render(payload = {}) : void {
        if (!this.terminal.isTTY()) {
            return;
        }
        const stringToRender = this.bars.reduce((prev, curr) => prev + curr.bar.getRenderString(payload), '');
        // this.terminal.moveCursor(0, null);
        this.terminal.restoreCursor();
        this.terminal.clearRight();
        this.terminal.clearBottom();
        this.terminal.write(stringToRender);

        this.lastDrawnString = stringToRender;
        this.lastDrawnTime = Date.now();
    }

    updateBar(name: string, updateObj: any) : void {
        const barToUpdate = this.bars.find(obj => obj.name === name).bar;
        const item = barToUpdate.getItem(updateObj.name);
        
        let finishedStatus = false;
        let itemFailure = false;
        
        if (item) {
            finishedStatus = item.finished;
            itemFailure = item.status.includes(this.options.itemFailedSubString);
            if (item.status !== updateObj.payload.ResourceStatus && !itemFailure) {
                barToUpdate.updateItem(updateObj.name, updateObj.payload);
            }
        } else {
            barToUpdate.addItem(updateObj.name, updateObj.payload);
        }
        if (this.options.itemCompleteStatus.includes(updateObj.payload.ResourceStatus) && !finishedStatus && !itemFailure) {
            barToUpdate.increment(updateObj.increment);
        }
        this.render();
    }

    incrementBar(name: string, value: number) : void {
        const barToUpdate = this.bars.find(obj => obj.name === name).bar;
        barToUpdate.increment(value);
        this.render();
    }

    finishBar(name: string) : void {
        const barToUpdate = this.bars.find(obj => obj.name === name).bar;
        if (!barToUpdate.hasFinished()) {
            barToUpdate.finish();
        }
        this.render();
    }

    create(bars: any[]) : void {
        if (!this.terminal.isTTY()) {
            return;
        }
        
        if (!this.bars.length) {
            this.terminal.saveCursor();
            if (this.options.hideCursor === true) {
                this.terminal.cursor(false);
            }
    
            if (this.options.lineWrap === false) {
                this.terminal.lineWrapping(false);
            }
            this.isActive = true;
        }
        bars.forEach(config => {
            const newBar = new Bar(this.options);
            newBar.start(config.total, config.value, config.payload);
            this.bars.push({ name: config.name, bar: newBar });
        });
        this.render();
        this.count += bars.length;
    }

    stop() : void {
        this.isActive = false;
        this.bars.forEach(bar => bar.bar.stop());

        if (this.options.hideCursor) {
            this.terminal.cursor(true);
        }

        if (!this.options.lineWrap) {
            this.terminal.lineWrapping(true);
        }

        // this.terminal.clearRight();
        // this.terminal.clearBottom();
        this.terminal.newLine();
    } 
}
