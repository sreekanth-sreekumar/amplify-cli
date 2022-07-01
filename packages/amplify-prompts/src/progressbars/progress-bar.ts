/* eslint-disable prefer-template */
/* eslint-disable spellcheck/spell-checker */
/* eslint-disable comma-dangle */
/* eslint-disable indent */
/* eslint-disable no-trailing-spaces */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable jsdoc/require-jsdoc */
import { AmplifyTerminal as Terminal } from './terminal';

export class ProgressBar { 
    private value: number;
    private total: number;
    private terminal: any;
    private startValue: number;
    private payload: any;
    private lastDrawnString: string;
    private isActive: boolean;
    private options: any;
    private items: {
        name: string,
        status: string,
        renderString: string,
        finished: boolean
    }[];

    barCompleteString: string;
    barIncompleteString: string;
    barSize: number;

    constructor(options: any) {
        this.terminal = new Terminal();
        this.value = 0;
        this.total = 0;
        this.options = options;
        this.items = [];
        this.lastDrawnString = '';
        this.startValue = 0;
        this.isActive = false;

        this.barCompleteString = (new Array(40 + 1).join(options.barCompleteChar || '='));
        this.barIncompleteString = (new Array(40 + 1).join(options.barIncompleteChar || '-'));
        this.barSize = options.barSize || 40;
    }

    getRenderString() : string {
        let finalString = '';
        const progressBar = '\n' + this.options.progressBarFormatter.call(this, { 
            value: this.value, total: this.total 
        }, this.payload, {
            barSize: this.barSize,
            barCompleteString: this.barCompleteString,
            barIncompleteString: this.barIncompleteString
        }) + '\n\n';
        finalString += progressBar;
        finalString = this.items.reduce((prev, curr) => prev + '\t' + curr.renderString + '\n', finalString);
        return finalString;
    }

    render() : void {
        const stringToRender = this.getRenderString();
        if (this.lastDrawnString !== stringToRender) {
            this.terminal.restoreCursor();
            this.terminal.clearRight();
            this.terminal.clearBottom();
            this.terminal.write(stringToRender);

            this.lastDrawnString = stringToRender;
        }
    }

    hasFinished() : boolean {
        return this.value === this.total;
    }

    start(total: number, startValue: number, payload: any) : void {
        if (!this.terminal.isTTY()) {
            return;
        }
        
        this.startValue = startValue || 0;
        this.total = (typeof total !== 'undefined' && total >= 0) ? total : 100;

        this.value = this.startValue;
        this.payload = payload || {};
        this.lastDrawnString = '';
        
        this.isActive = true;

        if (this.options.loneWolf) {
            this.terminal.saveCursor();
        
            if (this.options.hideCursor === true) {
                this.terminal.cursor(false);
            }
    
            if (this.options.lineWrap === false) {
                this.terminal.lineWrapping(false);
            }
            this.render();
        }
    }

    stop() : void {
        this.isActive = false;
        if (this.options.loneWolf) {
            if (this.options.hideCursor) {
                this.terminal.cursor(true);
            }

            if (!this.options.lineWrap) {
                this.terminal.lineWrapping(true);
            }
            this.terminal.clearRight();
            this.terminal.clearBottom();
            this.terminal.newLine();
        }
    }

    hasItem(name: string) : any {
        return (this.items.findIndex(item => item.name === name) !== -1);
    }

    getItem(name: string) : any {
        return this.items.find(item => item.name === name);
    }

    addItem(name: string, itemPayload: any) : void {
        const renderString = this.options.itemFormatter.call(this, itemPayload);
        const status = itemPayload.ResourceStatus;
        this.items.push({ 
            name, 
            status, 
            renderString, 
            finished: status === this.options.itemCompleteStatus
        });
        if (this.options.loneWolf) {
            this.render();
        }
    }

    updateItem(name: string, newPayload: any) : void {
        const newItemsSet = this.items.map(item => {
            let found = false;
            if (item.name === name) {
                found = true;
            }
            return {
                name: item.name,
                status: found ? newPayload.ResourceStatus : item.status,
                finished: found ? item.finished || this.options.itemCompleteStatus.includes(newPayload.ResourceStatus) : item.finished,
                renderString: found ? this.options.itemFormatter.call(this, newPayload) : item.renderString
            };
        });
        this.items = newItemsSet;
        if (this.options.loneWolf) {
            this.render();
        }
    }

    increment(value = 1) : void {
        this.value += value;
        if (this.options.loneWolf) {
            this.render();
        }
    }

    finish() : void {
        const diff = this.total - this.value;
        this.increment(diff);
    }
}
