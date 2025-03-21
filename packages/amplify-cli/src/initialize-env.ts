import ora from 'ora';
import sequential from 'promise-sequential';
import {
  stateManager, $TSAny, $TSMeta, $TSContext,
} from 'amplify-cli-core';
import { printer } from 'amplify-prompts';
import { ensureEnvParamManager, IEnvironmentParameterManager } from '@aws-amplify/amplify-environment-parameters';
import { getProviderPlugins } from './extensions/amplify-helpers/get-provider-plugins';
import { ManuallyTimedCodePath } from './domain/amplify-usageData/IUsageData';

const spinner = ora('');

/**
 * Entry point for initializing an environment. Delegates out to plugins initEnv function
 */
export const initializeEnv = async (
  context: $TSContext,
  currentAmplifyMeta: $TSMeta = stateManager.currentMetaFileExists() ? stateManager.getCurrentMeta() : undefined,
): Promise<void> => {
  const currentEnv = context.exeInfo.localEnvInfo.envName;
  const isPulling = context.input.command === 'pull' || (context.input.command === 'env' && context.input.subCommands[0] === 'pull');

  try {
    const { projectPath } = context.exeInfo.localEnvInfo;

    const amplifyMeta: $TSMeta = { providers: {} };
    const teamProviderInfo = stateManager.getTeamProviderInfo(projectPath);

    amplifyMeta.providers.awscloudformation = teamProviderInfo?.[currentEnv]?.awscloudformation;

    const envParamManager = (await ensureEnvParamManager(currentEnv)).instance;

    if (!context.exeInfo.restoreBackend) {
      mergeBackendConfigIntoAmplifyMeta(projectPath, amplifyMeta);
      mergeCategoryEnvParamsIntoAmplifyMeta(envParamManager, amplifyMeta, 'hosting', 'ElasticContainer');
      stateManager.setMeta(projectPath, amplifyMeta);
    }

    const categoryInitializationTasks: (() => Promise<$TSAny>)[] = [];

    const initializedCategories = Object.keys(stateManager.getMeta());
    const categoryPluginInfoList = context.amplify.getAllCategoryPluginInfo(context);
    const availableCategories = Object.keys(categoryPluginInfoList).filter(key => initializedCategories.includes(key));

    availableCategories.forEach(category => {
      categoryPluginInfoList[category].forEach(pluginInfo => {
        try {
          // eslint-disable-next-line import/no-dynamic-require, global-require, @typescript-eslint/no-var-requires
          const { initEnv } = require(pluginInfo.packageLocation);

          if (initEnv) {
            categoryInitializationTasks.push(() => initEnv(context));
          }
        } catch (e) {
          context.print.warning(`Could not load initEnv for ${category}`);
        }
      });
    });

    const providerPlugins = getProviderPlugins(context);

    const initializationTasks: (() => Promise<$TSAny>)[] = [];
    const providerPushTasks: (() => Promise<$TSAny>)[] = [];

    context.exeInfo.projectConfig.providers.forEach(provider => {
      // eslint-disable-next-line import/no-dynamic-require, global-require, @typescript-eslint/no-var-requires
      const providerModule = require(providerPlugins[provider]);
      initializationTasks.push(() => providerModule.initEnv(context, amplifyMeta.providers[provider]));
    });

    spinner.start(
      isPulling ? `Fetching updates to backend environment: ${currentEnv} from the cloud.` : `Initializing your environment: ${currentEnv}`,
    );

    try {
      context.usageData.startCodePathTimer(ManuallyTimedCodePath.INIT_ENV_PLATFORM);
      await sequential(initializationTasks);
    } catch (e) {
      printer.error(`Could not initialize '${currentEnv}': ${e.message}`);
      printer.debug(e.stack);
      context.usageData.emitError(e);
      process.exit(1);
    } finally {
      context.usageData.stopCodePathTimer(ManuallyTimedCodePath.INIT_ENV_PLATFORM);
    }

    spinner.succeed(
      isPulling ? `Successfully pulled backend environment ${currentEnv} from the cloud.` : 'Initialized provider successfully.',
    );

    const projectDetails = context.amplify.getProjectDetails();

    context.exeInfo = context.exeInfo || {};
    Object.assign(context.exeInfo, projectDetails);

    context.usageData.startCodePathTimer(ManuallyTimedCodePath.INIT_ENV_CATEGORIES);
    await sequential(categoryInitializationTasks);
    context.usageData.stopCodePathTimer(ManuallyTimedCodePath.INIT_ENV_CATEGORIES);

    if (context.exeInfo.forcePush === undefined) {
      context.exeInfo.forcePush = await context.amplify.confirmPrompt(
        'Do you want to push your resources to the cloud for your environment?',
      );
    }

    if (context.exeInfo.forcePush) {
      // eslint-disable-next-line no-restricted-syntax
      for (const provider of context.exeInfo.projectConfig.providers) {
        // eslint-disable-next-line import/no-dynamic-require, global-require, @typescript-eslint/no-var-requires
        const providerModule = require(providerPlugins[provider]);

        const resourceDefinition = await context.amplify.getResourceStatus(undefined, undefined, provider);
        providerPushTasks.push(() => providerModule.pushResources(context, resourceDefinition));
      }

      await sequential(providerPushTasks);
    }

    // Generate AWS exports/configuration file
    await context.amplify.onCategoryOutputsChange(context, currentAmplifyMeta);

    printer.success(isPulling ? '' : 'Initialized your environment successfully.');
  } catch (e) {
    spinner.fail('There was an error initializing your environment.');
    throw e;
  }
};

const mergeBackendConfigIntoAmplifyMeta = (projectPath: string, amplifyMeta: $TSMeta): void => {
  const backendConfig = stateManager.getBackendConfig(projectPath);
  Object.assign(amplifyMeta, backendConfig);
};

const mergeCategoryEnvParamsIntoAmplifyMeta = (
  envParamManager: IEnvironmentParameterManager,
  amplifyMeta: $TSMeta,
  category: string,
  serviceName: string,
): void => {
  if (
    envParamManager.hasResourceParamManager(category, serviceName)
    && envParamManager.getResourceParamManager(category, serviceName).hasAnyParams()
  ) {
    Object.assign(amplifyMeta[category][serviceName], envParamManager.getResourceParamManager(category, serviceName).getAllParams());
  }
};
