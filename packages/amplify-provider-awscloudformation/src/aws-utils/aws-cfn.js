// disabling lint until this file is converted to TS
/* eslint-disable */
const fs = require('fs-extra');
const path = require('path');
const _ = require('lodash');
const BottleNeck = require('bottleneck');
const chalk = require('chalk');
const columnify = require('columnify');

const aws = require('./aws');
const { S3 } = require('./aws-s3');
const providerName = require('../constants').ProviderName;
const { formUserAgentParam } = require('./user-agent');
const configurationManager = require('../configuration-manager');
const { stateManager, pathManager } = require('amplify-cli-core');
const { fileLogger } = require('../utils/aws-logger');
const logger = fileLogger('aws-cfn');
const { pagedAWSCall } = require('./paged-call');

const cliProgress = require('cli-progress');
const { MultiProgressBar } = require('amplify-prompts');

const CFN_MAX_CONCURRENT_REQUEST = 5;
const CFN_POLL_TIME = 5 * 1000; // 5 secs wait to check if  new stacks are created by root stack
let CFNLOG = [];
const CFN_SUCCESS_STATUS = ['UPDATE_COMPLETE', 'CREATE_COMPLETE', 'DELETE_COMPLETE', 'DELETE_SKIPPED'];

const CNF_ERROR_STATUS = ['CREATE_FAILED', 'DELETE_FAILED', 'UPDATE_FAILED'];
class CloudFormation {
  constructor(context, userAgentAction, options = {}, eventMap = {}) {
    return (async () => {
      let userAgentParam;
      if (userAgentAction) {
        userAgentParam = formUserAgentParam(context, userAgentAction);
      }
      
      this.pollQueue = new BottleNeck({ minTime: 100, maxConcurrent: CFN_MAX_CONCURRENT_REQUEST });
      this.pollQueueStacks = [];
      this.stackEvents = [];
      let cred;
      try {
        cred = await configurationManager.loadConfiguration(context);
      } catch (e) {
        // no credential. New project
      }
      const userAgentOption = {};
      if (userAgentAction) {
        userAgentOption.customUserAgent = userAgentParam;
      }

      this.cfn = new aws.CloudFormation({ ...cred, ...options, ...userAgentOption });
      this.context = context;
      if (Object.keys(eventMap).length !== 0) {
        this.eventMap = eventMap;
        // this.stackTrace = {
        //   'rootStack': []
        // }
        // this.eventMap['categories'].forEach(category => this.stackTrace[category.name] = [])
        this.progressBar = this.initializeProgressBars();
      }
      return this;
    })();
  }

  // createFormat(options, params, payload) {

  //   // if (!payload.hasOwnProperty('logicalResourceId')) {
  //     const completeSize = Math.round(params.progress*options.barsize);
  //     const incompleteSize = options.barsize-completeSize;

  //     // generate bar string by stripping the pre-rendered strings
  //     const bar = options.barCompleteString.substr(0, completeSize) +
  //           options.barGlue +
  //           options.barIncompleteString.substr(0, incompleteSize);

  //     return `Deploying ${payload.progressName} on env: ${payload.envName} || ${bar}`
  //   // }

  //   // else {
  //   //   var e = [{
  //   //     logicalResourceId: payload.logicalResourceId,
  //   //     resourceType: payload.resourceType,
  //   //     resourceStatus: payload.resourceStatus,
  //   //     timeStamp: payload.timeStamp
  //   //   }]
  
  //   //   const output = columnify(e, {
  //   //     showHeaders: false,
  //   //     truncate: true,
  //   //     maxWidth: 30,
  //   //     minWidth: 30
  //   //   })
  
  //   //   return output;
  //   // }
    
  // }

  // createFormat(options, params, payload) {
  //   const completeSize = Math.round(params.progress*options.barsize);
  //     const incompleteSize = options.barsize-completeSize;

  //     // generate bar string by stripping the pre-rendered strings
  //     const bar = options.barCompleteString.substr(0, completeSize) +
  //           options.barGlue +
  //           options.barIncompleteString.substr(0, incompleteSize);

  //     return `Deploying ${payload.progressName} on env: ${payload.envName} || ${bar}`
  // }

  createItemFormatter(payload) {
    var e = [{
      logicalResourceId: payload.LogicalResourceId,
      resourceType: payload.ResourceType,
      resourceStatus: payload.ResourceStatus,
      timeStamp: (new Date(payload.Timestamp)).toLocaleString()
    }]

    let output = columnify(e, {
      showHeaders: false,
      truncate: true,
      maxWidth: 30,
      minWidth: 30
    })

    if(["CREATE_COMPLETE", "UPDATE_COMPLETE"].includes(payload.ResourceStatus)) {
      output = chalk.green(output);
    }
    if (payload.ResourceStatus.includes('FAILED')) {
      output = chalk.red(output);
    }
    return output;
  }

  createProgressBarFormatter(params, payload, options) {
    const completeSize = Math.round((params.value/params.total)*40);
    const incompleteSize = options.barSize-completeSize;

    // generate bar string by stripping the pre-rendered strings
    const bar = options.barCompleteString.substr(0, completeSize) +
            options.barIncompleteString.substr(0, incompleteSize);
    
    const progressNameParts = payload.progressName.split("-");
    const name = progressNameParts.length === 1 ? progressNameParts[0] : `${progressNameParts[0]} ${progressNameParts[1]}`;
    return `Deploying ${name} on env: ${payload.envName} || ${bar} || ${params.value}/${params.total}`;
  }

  initializeProgressBars() {
    const newMultiBar = new MultiProgressBar({
      progressBarFormatter: this.createProgressBarFormatter,
      itemFormatter: this.createItemFormatter,
      loneWolf: false,
      hideCursor: true,
      lineWrap: false,
      barCompleteChar: '=',
      barIncompleteChar: '-',
      barSize: 40,
      itemCompleteStatus: ["CREATE_COMPLETE", "UPDATE_COMPLETE"],
      itemFailedSubString: 'FAILED'
    });
    let progressBarsConfigs = [];
    progressBarsConfigs.push({
      name: 'projectBar',
      value: 0,
      total: 1+this.eventMap['rootResources'].length,
      payload: {
        progressName: this.context.exeInfo.projectConfig.projectName,
        envName: this.context.exeInfo.localEnvInfo.envName
      }
    });

    progressBarsConfigs = this.eventMap['categories'].reduce((prev, curr) => {
      return prev.concat({
        name: curr.name,
        value: 0,
        total: curr.size,
        payload: {
          progressName: curr.name,
          envName: this.context.exeInfo.localEnvInfo.envName
        }
      })
    }, progressBarsConfigs);

    newMultiBar.create(progressBarsConfigs)
    return newMultiBar
  }

  // initializeProgressBars() {
  //   const rootProgressBar =  new cliProgress.MultiBar({
  //     format: `Deploying {progressName} on env: {envName} || {bar} || {value}/{total}`,
  //     clearOnComplete: true,
  //     hideCursor: true,
  //     stopOnComplete: true,
  //   }, cliProgress.Presets.shades_grey);

  //   let rootProjectBar = rootProgressBar.create(1+this.eventMap['rootResources'].length, 0, {
  //     progressName: this.context.exeInfo.projectConfig.projectName,
  //     envName: this.context.exeInfo.localEnvInfo.envName,
  //   });

  //   this.stackTrace['rootStack'].push({id: 'rootProjectBar', bar: rootProjectBar});

  //   const categoryBars = this.eventMap['categories'].map(category => {

  //     const categoryBar =  new cliProgress.MultiBar({
  //       format: `\nDeploying Resources of category: {category} || {bar} || {value}/{total}`,
  //       clearOnComplete: true,
  //       hideCursor: true,
  //       stopOnComplete: true,
  //     }, cliProgress.Presets.shades_grey);

  //     let categoryProgressBar = categoryBar.create(category.size, 0, {
  //       category: category.name
  //     });

  //     this.stackTrace[category.name].push({id: 'categoryProgressBar', bar: categoryProgressBar});

  //     return {
  //       name: category.name,
  //       statusBar: categoryBar
  //     }
  //   });
  //   return {
  //     'rootStatusBar': rootProgressBar,
  //     'categoryBars': categoryBars
  //   }
  // }

  // initializeProgressBars() {

  //   let progressBars = {
  //     'rootProgressBar': new cliProgress.MultiBar({
  //         format: 'Deploying Project: {projectName} on Env: {envName}: [{bar}] || {value}/{total}',
  //         clearOnComplete: false,
  //         hideCursor: true,
  //       }, cliProgress.Presets.shades_grey),
  //     'rootEventStatus': new cliProgress.MultiBar({
  //         format: '{resourceStatus} || {resourceType} || {logicalId}',
  //         clearOnComplete: false,
  //         hideCursor: true,
  //       }),

  //     'categoryBars': this.eventMap['categories'].map(category => ({
  //         name: category.name,
  //         progressBar: new cliProgress.MultiBar({
  //             format: 'Deploying {category} Category: [{bar}] || {value}/{total}',
  //             clearOnComplete: false,
  //             stopOnComplete: true,
  //             hideCursor: true,
  //           }, cliProgress.Presets.shades_grey),
  //         eventStatus: new cliProgress.MultiBar({
  //             format: '{resourceStatus} || {resourceType} || {logicalId}',
  //             clearOnComplete: false,
  //             hideCursor: true,
  //           })
  //       }))
  //   }
  //   return progressBars
  // }


  createResourceStack(cfnParentStackParams) {
    const cfnModel = this.cfn;
    const { context } = this;
    const cfnCompleteStatus = 'stackCreateComplete';
    const cfnStackCheckParams = {
      StackName: cfnParentStackParams.StackName,
    };
    const self = this;
    self.eventStartTime = new Date();

    return new Promise((resolve, reject) => {
      logger('cfnModel.createStack', [cfnParentStackParams])();
      cfnModel.createStack(cfnParentStackParams, createErr => {
        this.readStackEvents(cfnParentStackParams.StackName);
        logger('cfnModel.createStack', [cfnParentStackParams])(createErr);
        if (createErr) {
          context.print.error('\nAn error occurred when creating the CloudFormation stack');
          reject(createErr);
        }
        cfnModel.waitFor(cfnCompleteStatus, cfnStackCheckParams, async (completeErr, waitForStackdata) => {
          if (self.pollForEvents) {
            clearInterval(self.pollForEvents);
          }
          if (completeErr) {
            context.print.error('\nAn error occurred when creating the CloudFormation stack');
            await this.collectStackErrors(cfnParentStackParams.StackName);
            logger('cfnModel.createStack', [cfnParentStackParams])(completeErr);
            const error = new Error('Initialization of project failed');
            error.stack = null;
            reject(error);
          }
          resolve(waitForStackdata);
        });
      });
    });
  }

  collectStackErrors(stackName) {
    // add root stack to see the new stacks
    this.readStackEvents(stackName);
    // wait for the poll queue to drain
    return new Promise(resolve => {
      this.pollQueue.once('empty', () => {
        const failedStacks = this.stackEvents.filter(ev => CNF_ERROR_STATUS.includes(ev.ResourceStatus));

        try {
          const trace = this.generateFailedStackErrorMsgs(failedStacks);
          console.log(`\n\n${chalk.reset.red.bold('Following resources failed')}\n`);
          trace.forEach(t => {
            console.log(t);
            console.log('\n');
          });
          resolve();
        } catch (e) {
          Promise.reject(e);
        } finally {
          if (this.pollForEvents) {
            clearInterval(this.pollForEvents);
          }
        }
      });
    });
  }

  generateFailedStackErrorMsgs(eventsWithFailure) {
    let envRegExp = '';
    try {
      const { envName = '' } = this.context.amplify.getEnvInfo();
      envRegExp = new RegExp(`(-|_)${envName}`);
    } catch {}
    this.context.exeInfo.cloudformationEvents = CFNLOG;
    const stackTrees = eventsWithFailure
      .filter(stack => stack.ResourceType !== 'AWS::CloudFormation::Stack')
      .filter(stack => this.eventMap['eventToCategories'].has(stack.LogicalResourceId))
      .map(event => {
        const err = [];
        const resourceName = event.LogicalResourceId;
        const cfnURL = getCFNConsoleLink(event, this.cfn);
        err.push(`${chalk.red.bold('Resource Name:')} ${resourceName} (${event.ResourceType})`);
        err.push(`${chalk.red.bold('Event Type:')} ${getStatusToErrorMsg(event.ResourceStatus)}`);
        err.push(`${chalk.red.bold('Reason:')} ${event.ResourceStatusReason}`);
        if (cfnURL) {
          err.push(`${chalk.red.bold('URL:')} ${cfnURL}`);
        }
        return err.join('\n');
      });
    return stackTrees;
  }

  readStackEvents(stackName) {
    this.pollForEvents = setInterval(() => this.addToPollQueue(stackName, 3), CFN_POLL_TIME);
  }

  pollStack(stackName) {
    return this.getStackEvents(stackName)
      .then(stackEvents => {
        const uniqueEvents = getUniqueStacksEvents(stackEvents);
        const nestedStacks = filterNestedStacks(uniqueEvents);

        nestedStacks.forEach(stackId => {
          if (stackId !== stackName) {
            this.addToPollQueue(stackId);
          }
        });
        this.showNewEvents(stackEvents);
      })
      .catch(err => {
        console.log(err);
      });
  }

  addToPollQueue(stackId, priority = 5) {
    if (!this.pollQueueStacks.includes(stackId)) {
      this.pollQueueStacks.push(stackId);
      this.pollQueue.schedule({ priority }, () => {
        this.removeFromPollQueue(stackId);
        return this.pollStack(stackId);
      });
    }
    return false;
  }

  removeFromPollQueue(stackId) {
    const index = this.pollQueueStacks.indexOf(stackId);
    if (index !== -1) {
      this.pollQueueStacks.splice(index, 1);
    }
  }
  showNewEvents(events) {
    const allShownEvents = this.stackEvents;
    let newEvents = [];

    if (allShownEvents.length) {
      newEvents = _.differenceBy(events, allShownEvents, 'EventId');
    } else {
      newEvents = events;
    }
    if(this.eventMap) {
      this.showEventProgress(_.uniqBy(newEvents, 'EventId'));
    }
    else {
      showEvents(_.uniqBy(newEvents, 'EventId'));
    }
    
    this.stackEvents = [...allShownEvents, ...newEvents];
  }

  showEventProgress(events) {
    events = events.reverse();
    if (events.length > 0) {
      events.forEach(event => {
        const finishStatus = ["CREATE_COMPLETE", "UPDATE_COMPLETE"].includes(event.ResourceStatus);
        let updateObj = {
          name: event.LogicalResourceId,
          payload: {
            LogicalResourceId: event.LogicalResourceId,
            ResourceType: event.ResourceType,
            ResourceStatus: event.ResourceStatus,
            Timestamp: event.Timestamp
        }}
        let item = this.eventMap['rootResources'].find(item => item.key === event.LogicalResourceId)
        if(event.LogicalResourceId === this.eventMap['rootStackName'] || item) {
          if (finishStatus && item) {
            this.progressBar.finishBar(item.category)
          }
          this.progressBar.updateBar('projectBar', updateObj);
        }
        else {
          const category = this.eventMap['eventToCategories'].get(event.LogicalResourceId);
          if (category) {
            this.progressBar.updateBar(category, updateObj);
          }
        }
      })
    }
  }

  // showEventProgress(events) {
  //   events = events.reverse();
  //   if(events.length > 0) {
  //     events.forEach(event => {
  //       // var e = [{
  //       //   logicalResourceId: event.LogicalResourceId,
  //       //   resourceType: event.ResourceType,
  //       //   resourceStatus: event.ResourceStatus,
  //       //   timeStamp: event.Timestamp
  //       // }]
    
  //       // const output = columnify(e, {
  //       //   showHeaders: false,
  //       //   truncate: true,
  //       //   maxWidth: 30,
  //       //   minWidth: 30
  //       // })
  //       if(event.LogicalResourceId === this.eventMap['rootStackName'] ||
  //         this.eventMap['rootResources'].includes(event.LogicalResourceId)) {
  //           this.progressBars['rootStatusBar'].log(output + '\n');
  //           let rootProgressBar = this.stackTrace['rootStack'].find(item => item.id === 'rootProjectBar');
  //           if(["CREATE_COMPLETE", "UPDATE_COMPLETE"].includes(event.ResourceStatus)) {
  //             rootProgressBar.bar.increment();
  //           }
  //       }
  //       else {
  //         const category = this.eventMap['eventToCategories'].get(event.LogicalResourceId)
  //         if (category) {
  //           let categoryBar = this.progressBars['categoryBars'].find(obj => obj.name === category);
  //           categoryBar.statusBar.log(output+ '\n');
  //           if(["CREATE_COMPLETE", "UPDATE_COMPLETE"].includes(event.ResourceStatus)) {
  //             let categoryProgressBar = this.stackTrace[category].find(item => item.id === 'categoryProgressBar');
  //             categoryProgressBar.bar.increment();
  //           }

  //         }
  //       }
  //           // let savedEvent = this.stackTrace['rootStack'].find(item => item.id === event.LogicalResourceId);
  //           // if (savedEvent) {
  //           //   savedEvent.bar.update(1, {
  //           //     resourceStatus: event.ResourceStatus,
  //           //     timeStamp: event.Timestamp
  //           //   });
  //           //   let rootProgressBar = this.stackTrace['rootStack'].find(item => item.id === 'rootProjectBar');
  //           //   if(["CREATE_COMPLETE", "UPDATE_COMPLETE"].includes(event.ResourceStatus)) {
  //           //     rootProgressBar.bar.update(1);
  //           //     savedEvent.bar.stop();
  //           //   }
  //           // }
  //           // else {
  //           //   let statusBar = this.progressBars['rootStatusBar'].create(10, 0, {
  //           //     resourceStatus: event.ResourceStatus,
  //           //     resourceType: event.ResourceType,
  //           //     logicalResourceId: event.LogicalResourceId,
  //           //     timeStamp: event.Timestamp
  //           //   })
  //           //   const rootStackTrace = this.stackTrace['rootStack'].concat([
  //           //     {id: event.LogicalResourceId, bar: statusBar}])
  //           //   this.stackTrace['rootStack'] = rootStackTrace;
  //           // }

  //       // else {
  //       //   const category = this.eventMap['eventToCategories'].get(event.LogicalResourceId)
  //       //   if(category) {
  //       //     let savedEvent = this.stackTrace[category].find(item => item.id === event.LogicalResourceId);
  //       //     if (savedEvent) {
  //       //       savedEvent.bar.update(1, {
  //       //         resourceStatus: event.ResourceStatus,
  //       //         timeStamp: event.Timestamp
  //       //       });
  //       //       let categoryProgressBar = this.stackTrace[category].find(item => item.id === 'categoryProgressBar');
  //       //       if(["CREATE_COMPLETE", "UPDATE_COMPLETE"].includes(event.ResourceStatus)) {
  //       //         categoryProgressBar.bar.update(1);
  //       //         savedEvent.bar.stop();
  //       //       }
  //       //     }
  //       //     else {
  //       //       let categoryBar = this.progressBars['categoryBars'].find(obj => obj.name === category);
  //       //       let categoryStatusBar = categoryBar.statusBar.create(10, 0, {
  //       //         resourceStatus: event.ResourceStatus,
  //       //         resourceType: event.ResourceType,
  //       //         logicalResourceId: event.LogicalResourceId,
  //       //         timeStamp: event.Timestamp
  //       //       })
  //       //       const rootStackTrace = this.stackTrace[category].concat([
  //       //         {id: event.LogicalResourceId, bar: categoryStatusBar}
  //       //       ])
  //       //       this.stackTrace[category] = rootStackTrace;
  //       //     }
  //       //   }
  //       // }
  //     })
  //   }
  // } 

  // showEventProgress(events) {
  //   events = events.reverse();

  //   if (events.length > 0) {
  //     events.forEach(event => {
  //       if(event.LogicalResourceId === this.eventMap['rootStackName'] ||
  //        this.eventMap['rootResources'].includes(event.LogicalResourceId)) {
  //         if (!this.stackTrace['rootStack'].length) {
  //           let rootProgressBar = this.progressBars['rootProgressBar'].create(1+this.eventMap['rootResources'].length, 0, {
  //             projectName: this.context.exeInfo.projectConfig.projectName,
  //             envName: this.context.exeInfo.localEnvInfo.envName
  //           })
  //           const payload = {
  //             resourceStatus: event.ResourceStatus,
  //             resourceType: event.ResourceType,
  //             logicalId: event.LogicalResourceId
  //           }
  //           let rootStatusBar = this.progressBars['rootEventStatus'].create(5, 0, payload)
  //           const rootStackTrace = this.stackTrace['rootStack'].concat([
  //             {id: 'rootProgressBar', bar: rootProgressBar },
  //             {id: event.LogicalResourceId, bar: rootStatusBar}
  //           ])
  //           this.stackTrace['rootStack'] = rootStackTrace;
  //         }
  //         else {
  //           let savedEvent = this.stackTrace['rootStack'].find(item => item.id === event.LogicalResourceId);
  //           if (savedEvent) {
  //             let rootProgressBar = this.stackTrace['rootStack'].find(item => item.id === 'rootProgressBar');
  //             const payload =  {
  //               resourceStatus: event.ResourceStatus
  //             }
  //             savedEvent.bar.update(1, payload)
  //             rootProgressBar.bar.update(1)
  //           }
  //           else {
  //             const payload = {
  //               resourceStatus: event.ResourceStatus,
  //               resourceType: event.ResourceType,
  //               logicalId: event.LogicalResourceId
  //             }
  //             let rootStatusBar = this.progressBars['rootEventStatus'].create(5, 0, payload)
  //             const rootStackTrace = this.stackTrace['rootStack'].concat([
  //               {id: event.LogicalResourceId, bar: rootStatusBar}
  //             ])
  //             this.stackTrace['rootStack'] = rootStackTrace;
  //           }
  //         }
  //       }
  //       else {
  //         const category = this.eventMap['eventToCategories'].get(event.LogicalResourceId)
  //         if (category) {
  //           if (!this.stackTrace[category].length) {
  //             let categoryDetails = this.eventMap['categories'].find(obj => obj.name === category);
  //             let categoryBars = this.progressBars['categoryBars'].find(obj => obj.name === category);
  //             let categoryProgressBar = categoryBars.progressBar.create(categoryDetails.size, 0, {
  //               category: category
  //             })
  //             const payload = {
  //               resourceStatus: event.ResourceStatus,
  //               resourceType: event.ResourceType,
  //               logicalId: event.LogicalResourceId
  //             }
  //             let categoryStatusBar = categoryBars.eventStatus.create(5, 0, payload)
  //             const categoryStackTrace = this.stackTrace[category].concat([
  //               {id: 'categoryProgressBar', bar: categoryProgressBar },
  //               {id: event.LogicalResourceId, bar: categoryStatusBar}
  //             ])
  //             this.stackTrace[category] = categoryStackTrace;
  //           }
  //           else {
  //             let savedEvent = this.stackTrace[category].find(item => item.id === event.LogicalResourceId);
  //             if (savedEvent) {
  //               let categoryProgressBar = this.stackTrace[category].find(item => item.id === 'categoryProgressBar');
  //               const payload =  {
  //                 resourceStatus: event.ResourceStatus
  //               }
  //               savedEvent.bar.update(1, payload)
  //               categoryProgressBar.bar.update(1)
  //             }
  //             else {
  //               let categoryBars = this.progressBars['categoryBars'].find(obj => obj.name === category);
  //               let categoryStatusBar = categoryBars.eventStatus.create(5, 0, {
  //                 resourceStatus: event.ResourceStatus,
  //                 resourceType: event.ResourceType,
  //                 logicalId: event.LogicalResourceId
  //               })
  //               const rootStackTrace = this.stackTrace['rootStack'].concat([
  //                 {id: event.LogicalResourceId, bar: categoryStatusBar}
  //               ])
  //               this.stackTrace['rootStack'] = rootStackTrace;
  //             }
  //           }
  //         }
  //       }
  //     })
  //   }
  // }

  getStackEvents(stackName) {
    const self = this;
    const describeStackEventsArgs = { StackName: stackName };
    const log = logger('getStackEvents.cfnModel.describeStackEvents', [describeStackEventsArgs]);
    log();
    return this.cfn
      .describeStackEvents({ StackName: stackName })
      .promise()
      .then(data => {
        let events = data.StackEvents;
        events = events.filter(event => self.eventStartTime < new Date(event.Timestamp));
        return Promise.resolve(events);
      })
      .catch(e => {
        log(e);
        if (e && e.code === 'Throttling') {
          return Promise.resolve([]);
        }
        return Promise.reject(e);
      });
  }

  getStackParameters(stackName) {
    return this.cfn
      .describeStack({ StackName: stackName })
      .promise()
      .then(data => {
        return data.Parameters;
      });
  }

  updateResourceStack(filePath) {
    const cfnFile = path.parse(filePath).base;
    const projectDetails = this.context.amplify.getProjectDetails();
    const providerMeta = projectDetails.amplifyMeta.providers ? projectDetails.amplifyMeta.providers[providerName] : {};

    const stackName = providerMeta.StackName  || '';
    const stackId = providerMeta.StackId || '';

    const deploymentBucketName = projectDetails.amplifyMeta.providers
      ? projectDetails.amplifyMeta.providers[providerName].DeploymentBucketName
      : '';
    const authRoleName = projectDetails.amplifyMeta.providers ? projectDetails.amplifyMeta.providers[providerName].AuthRoleName : '';
    const unauthRoleName = projectDetails.amplifyMeta.providers ? projectDetails.amplifyMeta.providers[providerName].UnauthRoleName : '';

    const Tags = this.context.amplify.getTags(this.context);

    if (!stackName) {
      throw new Error('Project stack has not been created yet. Use amplify init to initialize the project.');
    }
    if (!deploymentBucketName) {
      throw new Error('Project deployment bucket has not been created yet. Use amplify init to initialize the project.');
    }

    return S3.getInstance(this.context)
      .then(s3 => {
        const s3Params = {
          Body: fs.createReadStream(filePath),
          Key: cfnFile,
        };
        logger('updateResourceStack.s3.uploadFile', [{ Key: s3Params.cfnFile }])();
        return s3.uploadFile(s3Params, false);
      })
      .then(bucketName => {
        const templateURL = `https://s3.amazonaws.com/${bucketName}/${cfnFile}`;
        const cfnStackCheckParams = {
          StackName: stackName,
        };
        const cfnModel = this.cfn;
        const { context } = this;
        const self = this;
        this.eventStartTime = new Date();
        return new Promise((resolve, reject) => {
          logger('updateResourceStack.describeStack', [cfnStackCheckParams])();
          this.describeStack(cfnStackCheckParams)
            .then(() => {
              const cfnParentStackParams = {
                StackName: stackName,
                TemplateURL: templateURL,
                Capabilities: ['CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND'],
                Parameters: [
                  {
                    ParameterKey: 'DeploymentBucketName',
                    ParameterValue: deploymentBucketName,
                  },
                  {
                    ParameterKey: 'AuthRoleName',
                    ParameterValue: authRoleName,
                  },
                  {
                    ParameterKey: 'UnauthRoleName',
                    ParameterValue: unauthRoleName,
                  },
                ],
                Tags,
              };
              logger('updateResourceStack.updateStack', [cfnStackCheckParams])();
              cfnModel.updateStack(cfnParentStackParams, updateErr => {
                self.readStackEvents(stackName);

                const cfnCompleteStatus = 'stackUpdateComplete';
                if (updateErr) {
                  if (self.pollForEvents) {
                    clearInterval(self.pollForEvents);
                  }
                  return reject(updateErr);
                }
                cfnModel.waitFor(cfnCompleteStatus, cfnStackCheckParams, completeErr => {
                  if (self.pollForEvents) {
                    clearInterval(self.pollForEvents);
                  }
                  this.progressBar.stop();
                  if (completeErr) {
                    this.collectStackErrors(cfnParentStackParams.StackName).then(() => reject(completeErr));
                  } else {
                    self.context.usageData.calculatePushNormalizationFactor(this.stackEvents, stackId);
                    return self.updateamplifyMetaFileWithStackOutputs(stackName).then(() => resolve());
                  }
                });
              });
            })
            .catch(err => {
              reject(new Error("Project stack doesn't exist"));
              context.print.info(err.stack);
            });
        });
      });
  }

  async listStacks(nextToken = null, stackStatusFilter) {
    return await this.cfn
      .listStacks({
        NextToken: nextToken,
        StackStatusFilter: stackStatusFilter,
      })
      .promise();
  }

  async updateamplifyMetaFileWithStackOutputs(parentStackName) {
    const cfnParentStackParams = {
      StackName: parentStackName,
    };
    const projectDetails = this.context.amplify.getProjectDetails();
    const { amplifyMeta } = projectDetails;

    logger('updateamplifyMetaFileWithStackOutputs.cfn.listStackResources', [cfnParentStackParams])();

    const stackSummaries = await pagedAWSCall(
      async (params, nextToken) => {
        return await this.cfn.listStackResources({ ...params, NextToken: nextToken }).promise();
      },
      {
        StackName: parentStackName,
      },
      response => response.StackResourceSummaries,
      async response => response.NextToken,
    );

    const resources = stackSummaries.filter(
      resource =>
        ![
          'DeploymentBucket',
          'AuthRole',
          'UnauthRole',
          'UpdateRolesWithIDPFunction',
          'UpdateRolesWithIDPFunctionOutputs',
          'UpdateRolesWithIDPFunctionRole',
        ].includes(resource.LogicalResourceId) && resource.ResourceType === 'AWS::CloudFormation::Stack',
    );
    /**
     * Update root stack overrides
     */
    const rootStackResources = stackSummaries.filter(
      resource =>
        !['UpdateRolesWithIDPFunction', 'UpdateRolesWithIDPFunctionOutputs', 'UpdateRolesWithIDPFunctionRole'].includes(
          resource.LogicalResourceId,
        ),
    );
    if (rootStackResources.length > 0) {
      const rootStackResult = await this.describeStack(cfnParentStackParams);
      Object.keys(amplifyMeta)
        .filter(k => k === 'providers')
        .forEach(category => {
          Object.keys(amplifyMeta[category]).forEach(key => {
            const formattedOutputs = formatOutputs(rootStackResult.Stacks[0].Outputs);
            this.context.amplify.updateProvideramplifyMeta('awscloudformation', formattedOutputs);
            /**
             * Write the new env specific datasource information into
             * the team-provider-info file
             */
            const { envName } = this.context.amplify.getEnvInfo();
            const projectPath = pathManager.findProjectRoot();
            const teamProviderInfo = stateManager.getTeamProviderInfo(projectPath);
            const tpiResourceParams = _.get(teamProviderInfo, [envName, 'awscloudformation'], {});
            _.assign(tpiResourceParams, stateManager.getMeta().providers.awscloudformation);
            _.set(teamProviderInfo, [envName, 'awscloudformation'], tpiResourceParams);
            stateManager.setTeamProviderInfo(projectPath, teamProviderInfo);
          });
        });
    }

    if (resources.length > 0) {
      const promises = [];

      for (let i = 0; i < resources.length; i++) {
        const cfnNestedStackParams = {
          StackName: resources[i].PhysicalResourceId,
        };

        promises.push(this.describeStack(cfnNestedStackParams));
      }

      const stackResult = await Promise.all(promises);

      Object.keys(amplifyMeta)
        .filter(k => k !== 'providers')
        .forEach(category => {
          Object.keys(amplifyMeta[category]).forEach(resource => {
            const logicalResourceId = category + resource;
            const index = resources.findIndex(resourceItem => resourceItem.LogicalResourceId === logicalResourceId);

            if (index !== -1) {
              const formattedOutputs = formatOutputs(stackResult[index].Stacks[0].Outputs);

              const updatedMeta = this.context.amplify.updateamplifyMetaAfterResourceUpdate(category, resource, 'output', formattedOutputs);

              // Check to see if this is an AppSync resource and if we've to remove the GraphQLAPIKeyOutput from meta or not
              if (amplifyMeta[category][resource]) {
                const resourceObject = amplifyMeta[category][resource];

                if (
                  resourceObject.service === 'AppSync' &&
                  resourceObject.output &&
                  resourceObject.output.GraphQLAPIKeyOutput &&
                  !formattedOutputs.GraphQLAPIKeyOutput
                ) {
                  const updatedResourceObject = updatedMeta[category][resource];

                  if (updatedResourceObject.output.GraphQLAPIKeyOutput) {
                    delete updatedResourceObject.output.GraphQLAPIKeyOutput;
                  }
                }

                if (resourceObject.service === 'S3AndCloudFront' && resourceObject.output) {
                  updatedMeta[category][resource].output = formattedOutputs;
                }

                stateManager.setMeta(undefined, updatedMeta);
              }
            }
          });
        });
    }
  }

  listExports(nextToken = null) {
    const log = logger('listExports.cfn.listExports', [{ NextToken: nextToken }]);
    return new Promise((resolve, reject) => {
      log();
      this.cfn.listExports(nextToken ? { NextToken: nextToken } : {}, (err, data) => {
        if (err) {
          log(err);
          reject(err);
        } else if (data.NextToken) {
          this.listExports(data.NextToken).then(innerExports => resolve([...data.Exports, ...innerExports]));
        } else {
          resolve(data.Exports);
        }
      });
    });
  }

  describeStack(cfnNestedStackParams, maxTry = 10, timeout = CFN_POLL_TIME) {
    const cfnModel = this.cfn;
    const log = logger('describeStack.cfn.describeStacks', [cfnNestedStackParams]);
    return new Promise((resolve, reject) => {
      log();
      cfnModel
        .describeStacks(cfnNestedStackParams)
        .promise()
        .then(result => resolve(result))
        .catch(e => {
          log(e);
          if (e.code === 'Throttling' && e.retryable) {
            setTimeout(() => {
              resolve(this.describeStack(cfnNestedStackParams, maxTry - 1, timeout));
            }, timeout);
          } else {
            reject(e);
          }
        });
    });
  }

  async listStackResources(stackId) {
    const meta = stateManager.getMeta();
    stackId = stackId || _.get(meta, ['providers', providerName, 'StackName'], undefined);
    if (!stackId) {
      throw new Error(`StackId not found in amplify-meta for provider ${providerName}`);
    }
    // StackName param can be a StackName, StackId, or a PhysicalResourceId
    return this.cfn.listStackResources({ StackName: stackId }).promise();
  }

  deleteResourceStack(envName) {
    const { teamProviderInfo } = this.context.amplify.getProjectDetails();
    const teamProvider = teamProviderInfo[envName][providerName];
    const stackName = teamProvider.StackName;
    if (!stackName) {
      throw new Error('Stack not defined for the environment.');
    }

    const cfnStackParams = {
      StackName: stackName,
    };

    const cfnModel = this.cfn;
    const log = logger('deleteResourceStack.cfn.describeStacks', [cfnStackParams]);

    return new Promise((resolve, reject) => {
      log();
      cfnModel.describeStacks(cfnStackParams, (err, data) => {
        const cfnDeleteStatus = 'stackDeleteComplete';
        if (
          (err && err.statusCode === 400 && err.message.includes(`${stackName} does not exist`)) ||
          data.StackStatus === 'DELETE_COMPLETE'
        ) {
          this.context.print.warning('Stack has already been deleted or does not exist');
          resolve();
        }
        if (err === null) {
          cfnModel.deleteStack(cfnStackParams, deleteErr => {
            if (deleteErr) {
              console.log(`Error deleting stack ${stackName}`);
              return reject(deleteErr);
            }
            cfnModel.waitFor(cfnDeleteStatus, cfnStackParams, completeErr => {
              if (err) {
                console.log(`Error deleting stack ${stackName}`);
                this.collectStackErrors(stackName).then(() => reject(completeErr));
              } else {
                resolve();
              }
            });
          });
        } else {
          log(err);
          reject(err);
        }
      });
    });
  }
}

function formatOutputs(outputs) {
  const formattedOutputs = {};
  for (let i = 0; i < outputs.length; i += 1) {
    formattedOutputs[outputs[i].OutputKey] = outputs[i].OutputValue;
  }

  return formattedOutputs;
}

function showEvents(events) {

  // CFN sorts the events by descending
  events = events.reverse();

  if (events.length > 0) {
    console.log('\n');
    const COLUMNS = ['ResourceStatus', 'LogicalResourceId', 'ResourceType', 'Timestamp', 'ResourceStatusReason'];

    const e = events.map(ev => {
      const res = {};
      const { ResourceStatus: resourceStatus } = ev;

      let colorFn = chalk.reset;
      if (CNF_ERROR_STATUS.includes(resourceStatus)) {
        colorFn = chalk.red;
      } else if (CFN_SUCCESS_STATUS.includes(resourceStatus)) {
        colorFn = chalk.green;
      }

      COLUMNS.forEach(col => {
        if (ev[col]) {
          res[col] = colorFn(ev[col]);
        }
      });
      return res;
    });

    const formattedEvents = columnify(e, {
      columns: COLUMNS,
      showHeaders: false,
    });
    CFNLOG = CFNLOG.concat(events);
    console.log(formattedEvents);
  }
}

// Unique events with last updated status
function getUniqueStacksEvents(events) {
  // sort in reverse chronological order
  const sortedEvents = [...events].sort((a, b) => b.TimeStamp - a.TimeStamp);
  return _.uniqBy(sortedEvents, 'PhysicalResourceId');
}

function filterNestedStacks(uniqueEvents, excludeWithStatus = CFN_SUCCESS_STATUS, includeWithStatus = []) {
  const nestedStacks = [];
  for (let i = 0; i < uniqueEvents.length; i += 1) {
    const { PhysicalResourceId: physicalResourceId, ResourceType: resourceType, ResourceStatus: status } = uniqueEvents[i];
    if (physicalResourceId && !nestedStacks.includes(physicalResourceId)) {
      if (resourceType === 'AWS::CloudFormation::Stack') {
        if (includeWithStatus.includes(status)) {
          nestedStacks.push(physicalResourceId);
        } else if (excludeWithStatus.length && !excludeWithStatus.includes(status)) {
          nestedStacks.push(physicalResourceId);
        }
      }
    }
  }
  return nestedStacks;
}

function getStatusToErrorMsg(status) {
  const MAP = {
    CREATE_FAILED: 'create',
    DELETE_FAILED: 'delete',
    UPDATE_FAILED: 'update',
  };
  return MAP[status] || status;
}

function getCFNConsoleLink(event, cfn) {
  if (event.ResourceStatus === 'CREATE_FAILED') {
    // Stacks get deleted and don't have perm link
    return null;
  }
  const arn = event.StackId;
  const { region } = cfn.config;
  return `https://console.aws.amazon.com/cloudformation/home?region=${region}#/stacks/${encodeURIComponent(arn)}/events`;
}

module.exports = CloudFormation;
