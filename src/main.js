import * as core from '@actions/core'
import {triggerCheck} from './functions/trigger-check'
import {contextCheck} from './functions/context-check'
import {reactEmote} from './functions/react-emote'
import {environmentTargets} from './functions/environment-targets'
import {actionStatus} from './functions/action-status'
import {createDeploymentStatus} from './functions/deployment'
import {prechecks} from './functions/prechecks'
import {validPermissions} from './functions/valid-permissions'
import {post} from './functions/post'
import {timeDiff} from './functions/time-diff'
import {identicalCommitCheck} from './functions/identical-commit-check'
import {help} from './functions/help'
import * as github from '@actions/github'
import {context} from '@actions/github'
import dedent from 'dedent-js'

// :returns: 'success', 'success - noop', 'success - merge deploy mode', 'failure', 'safe-exit', or raises an error
export async function run() {
  try {
    // Get the inputs for the branch-deploy Action
    const trigger = core.getInput('trigger')
    const reaction = core.getInput('reaction')
    const prefixOnly = core.getInput('prefix_only') === 'true'
    const token = core.getInput('github_token', {required: true})
    var environment = core.getInput('environment', {required: true})
    const stable_branch = core.getInput('stable_branch')
    const noop_trigger = core.getInput('noop_trigger')
    const production_environment = core.getInput('production_environment')
    const environment_targets = core.getInput('environment_targets')
    const help_trigger = core.getInput('help_trigger')
    const update_branch = core.getInput('update_branch')
    const required_contexts = core.getInput('required_contexts')
    const allowForks = core.getInput('allow_forks') === 'true'
    const skipCi = core.getInput('skip_ci')
    const skipReviews = core.getInput('skip_reviews')
    const mergeDeployMode = core.getInput('merge_deploy_mode') === 'true'
    const admins = core.getInput('admins')
    const environment_urls = core.getInput('environment_urls')

    // Create an octokit client
    const octokit = github.getOctokit(token)

    // Set the state so that the post run logic will trigger
    core.saveState('isPost', 'true')
    core.saveState('actionsToken', token)

    // If we are running in the merge deploy mode, run commit checks
    if (mergeDeployMode) {
      identicalCommitCheck(octokit, context, environment)
      // always bypass post run logic as they is an entirely alternate workflow from the core branch-deploy Action
      core.saveState('bypass', 'true')
      return 'success - merge deploy mode'
    }

    // Get the body of the IssueOps command
    const body = context.payload.comment.body.trim()

    // Check the context of the event to ensure it is valid, return if it is not
    if (!(await contextCheck(context))) {
      return 'safe-exit'
    }

    // Get variables from the event context
    const issue_number = context.payload.issue.number
    const {owner, repo} = context.repo

    // Check if the comment is a trigger and what type of trigger it is
    const isDeploy = await triggerCheck(prefixOnly, body, trigger)
    const isHelp = await triggerCheck(prefixOnly, body, help_trigger)

    // Loop through all the triggers and check if there are multiple triggers
    // If multiple triggers are activated, exit (this is not allowed)
    var multipleTriggers = false
    for (const trigger of [isDeploy, isHelp]) {
      if (trigger) {
        if (multipleTriggers) {
          core.saveState('bypass', 'true')
          core.setOutput('triggered', 'false')
          core.info(`body: ${body}`)
          core.setFailed(
            'IssueOps message contains multiple commands, only one is allowed'
          )
          return 'failure'
        }
        multipleTriggers = true
      }
    }

    if (!isDeploy && !isHelp) {
      // If the comment does not activate any triggers, exit
      core.saveState('bypass', 'true')
      core.setOutput('triggered', 'false')
      core.info('no trigger detected in comment - exiting')
      return 'safe-exit'
    } else if (isDeploy) {
      core.setOutput('type', 'deploy')
    } else if (isHelp) {
      core.setOutput('type', 'help')
    }

    // If we made it this far, the action has been triggered in one manner or another
    core.setOutput('triggered', 'true')

    // Add the reaction to the issue_comment which triggered the Action
    const reactRes = await reactEmote(reaction, context, octokit)
    core.setOutput('comment_id', context.payload.comment.id)
    core.saveState('comment_id', context.payload.comment.id)
    core.setOutput('initial_reaction_id', reactRes.data.id)
    core.saveState('reaction_id', reactRes.data.id)
    core.setOutput('actor_handle', context.payload.comment.user.login)

    // If the command is a help request
    if (isHelp) {
      core.debug('help command detected')
      // Check to ensure the user has valid permissions
      const validPermissionsRes = await validPermissions(octokit, context)
      // If the user doesn't have valid permissions, return an error
      if (validPermissionsRes !== true) {
        await actionStatus(
          context,
          octokit,
          reactRes.data.id,
          validPermissionsRes
        )
        // Set the bypass state to true so that the post run logic will not run
        core.saveState('bypass', 'true')
        core.setFailed(validPermissionsRes)
        return 'failure'
      }

      // rollup all the inputs into a single object
      const inputs = {
        trigger: trigger,
        reaction: reaction,
        prefixOnly: prefixOnly,
        environment: environment,
        stable_branch: stable_branch,
        noop_trigger: noop_trigger,
        production_environment: production_environment,
        environment_targets: environment_targets,
        help_trigger: help_trigger,
        update_branch: update_branch,
        required_contexts: required_contexts,
        allowForks: allowForks,
        skipCi: skipCi,
        skipReviews: skipReviews,
        admins: admins
      }

      // Run the help command and exit
      await help(octokit, context, reactRes.data.id, inputs)
      core.saveState('bypass', 'true')
      return 'safe-exit'
    }

    // Check if the default environment is being overwritten by an explicit environment
    const environmentObj = await environmentTargets(
      environment, // environment
      body, // comment body
      trigger, // trigger
      noop_trigger, // noop trigger
      stable_branch, // ref
      context, // context object
      octokit, // octokit object
      reactRes.data.id, // reaction id
      environment_urls // environment_urls action input
    )

    // deconstruct the environment object to get the environment
    environment = environmentObj.environment

    // If the environment targets are not valid, then exit
    if (!environment) {
      core.debug('No valid environment targets found')
      return 'safe-exit'
    }

    core.info(`environment: ${environment}`)
    core.saveState('environment', environment)
    core.setOutput('environment', environment)

    // Execute prechecks to ensure the Action can proceed
    const precheckResults = await prechecks(
      body,
      trigger,
      noop_trigger,
      update_branch,
      stable_branch,
      issue_number,
      allowForks,
      skipCi,
      skipReviews,
      environment,
      context,
      octokit
    )
    core.setOutput('ref', precheckResults.ref)
    core.saveState('ref', precheckResults.ref)
    core.setOutput('sha', precheckResults.sha)

    // If the prechecks failed, run the actionFailed function and return
    if (!precheckResults.status) {
      await actionStatus(
        context,
        octokit,
        reactRes.data.id,
        precheckResults.message
      )
      // Set the bypass state to true so that the post run logic will not run
      core.saveState('bypass', 'true')
      core.setFailed(precheckResults.message)
      return 'failure'
    }

    // Add a comment to the PR letting the user know that a deployment has been started
    // Format the success message
    var deploymentType
    if (precheckResults.noopMode) {
      deploymentType = 'noop'
    } else {
      deploymentType = 'branch'
    }
    const log_url = `${process.env.GITHUB_SERVER_URL}/${context.repo.owner}/${context.repo.repo}/actions/runs/${process.env.GITHUB_RUN_ID}`
    const commentBody = dedent(`
      ### Deployment Triggered 🚀

      __${context.actor}__, started a __${deploymentType}__ deployment to __${environment}__

      You can watch the progress [here](${log_url}) 🔗

      > __Branch__: \`${precheckResults.ref}\`
    `)

    // Make a comment on the PR
    await octokit.rest.issues.createComment({
      ...context.repo,
      issue_number: context.issue.number,
      body: commentBody
    })

    // Set outputs for noopMode
    var noop
    if (precheckResults.noopMode) {
      noop = 'true'
      core.setOutput('noop', noop)
      core.setOutput('continue', 'true')
      core.saveState('noop', noop)
      core.info('noop mode detected')
      // If noop mode is enabled, return
      return 'success - noop'
    } else {
      noop = 'false'
      core.setOutput('noop', noop)
      core.saveState('noop', noop)
    }

    // Get required_contexts for the deployment
    var requiredContexts = []
    if (
      required_contexts &&
      required_contexts !== '' &&
      required_contexts !== 'false'
    ) {
      requiredContexts = required_contexts.split(',').map(function (item) {
        return item.trim()
      })
    }

    // Check if the environment is a production_environment
    var productionEnvironment = false
    if (environment === production_environment.trim()) {
      productionEnvironment = true
    }
    core.debug(`production_environment: ${productionEnvironment}`)

    // if update_branch is set to 'disabled', then set auto_merge to false, otherwise set it to true
    const auto_merge = update_branch === 'disabled' ? false : true

    // Create a new deployment
    const {data: createDeploy} = await octokit.rest.repos.createDeployment({
      owner: owner,
      repo: repo,
      ref: precheckResults.ref,
      auto_merge: auto_merge,
      required_contexts: requiredContexts,
      environment: environment,
      // description: "",
      // :description note: Short description of the deployment.
      production_environment: productionEnvironment,
      // :production_environment note: specifies if the given environment is one that end-users directly interact with. Default: true when environment is production and false otherwise.
      payload: {
        type: 'branch-deploy'
      }
    })
    core.setOutput('deployment_id', createDeploy.id)
    core.saveState('deployment_id', createDeploy.id)

    // If a merge to the base branch is required, let the user know and exit
    if (
      typeof createDeploy.id === 'undefined' &&
      createDeploy.message.includes('Auto-merged')
    ) {
      const mergeMessage = dedent(`
        ### ⚠️ Deployment Warning

        - Message: ${createDeploy.message}
        - Note: If you have required CI checks, you may need to manually push a commit to re-run them

        > Deployment will not continue. Please try again once this branch is up-to-date with the base branch
        `)
      await actionStatus(context, octokit, reactRes.data.id, mergeMessage)
      core.warning(mergeMessage)
      // Enable bypass for the post deploy step since the deployment is not complete
      core.saveState('bypass', 'true')
      return 'safe-exit'
    }

    // Set the deployment status to in_progress
    await createDeploymentStatus(
      octokit,
      context,
      precheckResults.ref,
      'in_progress',
      createDeploy.id,
      environment,
      environmentObj.environmentUrl // environment_url (can be null)
    )

    core.setOutput('continue', 'true')
    return 'success'
  } catch (error) {
    core.saveState('bypass', 'true')
    core.error(error.stack)
    core.setFailed(error.message)
  }
}

/* istanbul ignore next */
if (core.getState('isPost') === 'true') {
  post()
} else {
  if (process.env.CI === 'true') {
    run()
  }
}
