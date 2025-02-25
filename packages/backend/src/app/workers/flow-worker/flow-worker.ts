import fs from 'fs-extra'
import {
    ActionType,
    ActivepiecesError,
    apId,
    CodeActionSettings,
    ErrorCode,
    ExecuteFlowOperation,
    ExecutionOutput,
    ExecutionOutputStatus,
    ExecutionType,
    File,
    FileId,
    flowHelper,
    FlowRunId,
    FlowVersion,
    FlowVersionState,
    ProjectId,
    StepOutputStatus,
    TriggerType,
} from '@activepieces/shared'
import { Sandbox, sandboxManager } from '../sandbox'
import { flowVersionService } from '../../flows/flow-version/flow-version.service'
import { fileService } from '../../file/file.service'
import { codeBuilder } from '../code-worker/code-builder'
import { flowRunService } from '../../flows/flow-run/flow-run-service'
import { OneTimeJobData } from './job-data'
import { engineHelper } from '../../helper/engine-helper'
import { acquireLock } from '../../database/redis-connection'
import { captureException, logger } from '../../helper/logger'
import { pieceManager } from '../../flows/common/piece-installer'
import { isNil } from 'lodash'

type FlowPiece = {
    name: string
    version: string
}

type InstallPiecesParams = {
    path: string
    flowVersion: FlowVersion
}

type FinishExecutionParams = {
    flowRunId: FlowRunId
    logFileId: FileId
    executionOutput: ExecutionOutput
}

type LoadInputAndLogFileIdParams = {
    jobData: OneTimeJobData
}

type LoadInputAndLogFileIdResponse = {
    input: ExecuteFlowOperation
    logFileId?: FileId | undefined
}

const extractFlowPieces = (flowVersion: FlowVersion): FlowPiece[] => {
    const pieces: FlowPiece[] = []
    const steps = flowHelper.getAllSteps(flowVersion)

    for (const step of steps) {
        if (step.type === TriggerType.PIECE || step.type === ActionType.PIECE) {
            const { pieceName, pieceVersion } = step.settings
            pieces.push({
                name: pieceName,
                version: pieceVersion,
            })
        }
    }

    return pieces
}

const installPieces = async (params: InstallPiecesParams): Promise<void> => {
    const { path, flowVersion } = params
    const pieces = extractFlowPieces(flowVersion)

    await pieceManager.install({
        projectPath: path,
        pieces,
    })
}

const finishExecution = async (params: FinishExecutionParams): Promise<void> => {
    logger.trace(params, '[FlowWorker#finishExecution] params')

    const { flowRunId, logFileId, executionOutput } = params

    if (executionOutput.status === ExecutionOutputStatus.PAUSED) {
        await flowRunService.pause({
            flowRunId,
            logFileId,
            pauseMetadata: executionOutput.pauseMetadata,
        })
    }
    else {
        await flowRunService.finish(flowRunId, executionOutput.status, logFileId)
    }
}

const loadInputAndLogFileId = async ({ jobData }: LoadInputAndLogFileIdParams): Promise<LoadInputAndLogFileIdResponse> => {
    const baseInput = {
        flowVersionId: jobData.flowVersionId,
        projectId: jobData.projectId,
        triggerPayload: {
            duration: 0,
            input: {},
            output: jobData.payload,
            status: StepOutputStatus.SUCCEEDED,
        },
    }

    if (jobData.executionType === ExecutionType.BEGIN) {
        return {
            input: {
                executionType: ExecutionType.BEGIN,
                ...baseInput,
            },
        }
    }

    const flowRun = await flowRunService.getOneOrThrow({
        id: jobData.runId,
        projectId: jobData.projectId,
    })

    if (isNil(flowRun.pauseMetadata) || isNil(flowRun.logsFileId)) {
        throw new ActivepiecesError({
            code: ErrorCode.VALIDATION,
            params: {
                message: `flowRunId=${flowRun.id}`,
            },
        })
    }

    const logFile = await fileService.getOneOrThrow({
        fileId: flowRun.logsFileId,
        projectId: jobData.projectId,
    })

    const serializedExecutionOutput = logFile.data.toString('utf-8')
    const executionOutput = JSON.parse(serializedExecutionOutput) as ExecutionOutput

    return {
        input: {
            executionType: ExecutionType.RESUME,
            executionState: executionOutput.executionState,
            resumeStepMetadata: flowRun.pauseMetadata.resumeStepMetadata,
            ...baseInput,
        },
        logFileId: logFile.id,
    }
}

async function executeFlow(jobData: OneTimeJobData): Promise<void> {
    logger.info(`[FlowWorker#executeFlow] flowRunId=${jobData.runId} executionType=${jobData.executionType}`)

    const flowVersion = await flowVersionService.getOneOrThrow(jobData.flowVersionId)

    // Don't use sandbox for draft versions, since they are mutable and we don't want to cache them.
    const key = flowVersion.id + (FlowVersionState.DRAFT === flowVersion.state ? '-draft' + apId() : '')
    const sandbox = await sandboxManager.obtainSandbox(key)
    const startTime = Date.now()
    logger.info(`[${jobData.runId}] Executing flow ${flowVersion.id} in sandbox ${sandbox.boxId}`)
    try {
        if (!sandbox.cached) {
            await sandbox.recreate()
            await downloadFiles(sandbox, jobData.projectId, flowVersion)

            const path = sandbox.getSandboxFolderPath()

            await installPieces({
                path,
                flowVersion,
            })

            logger.info(`[${jobData.runId}] Preparing sandbox ${sandbox.boxId} took ${Date.now() - startTime}ms`)
        }
        else {
            await sandbox.clean()
            logger.info(`[${jobData.runId}] Reusing sandbox ${sandbox.boxId} took ${Date.now() - startTime}ms`)
        }

        const { input, logFileId } = await loadInputAndLogFileId({ jobData })

        const { result: executionOutput } = await engineHelper.executeFlow(sandbox, input)

        const logsFile = await fileService.save({
            fileId: logFileId,
            projectId: jobData.projectId,
            data: Buffer.from(JSON.stringify(executionOutput)),
        })

        await finishExecution({
            flowRunId: jobData.runId,
            logFileId: logsFile.id,
            executionOutput,
        })

        logger.info(`[FlowWorker#executeFlow] flowRunId=${jobData.runId} executionOutputStats=${executionOutput.status} sandboxId=${sandbox.boxId} duration=${Date.now() - startTime} ms`)
    }
    catch (e: unknown) {
        if (e instanceof ActivepiecesError && (e as ActivepiecesError).error.code === ErrorCode.EXECUTION_TIMEOUT) {
            await flowRunService.finish(jobData.runId, ExecutionOutputStatus.TIMEOUT, null)
        }
        else {
            logger.error(e, `[${jobData.runId}] Error executing flow`)
            captureException(e as Error)
            await flowRunService.finish(jobData.runId, ExecutionOutputStatus.INTERNAL_ERROR, null)
        }

    }
    finally {
        await sandboxManager.returnSandbox(sandbox.boxId)
    }
}

async function downloadFiles(
    sandbox: Sandbox,
    projectId: ProjectId,
    flowVersion: FlowVersion,
): Promise<void> {
    logger.info(`[${flowVersion.id}] Acquiring flow lock to build codes`)
    const flowLock = await acquireLock({
        key: flowVersion.id,
        timeout: 60000,
    })
    try {
        const buildPath = sandbox.getSandboxFolderPath()

        // This has to be before flows, since it does modify code settings and fill it with packaged file id.
        await fs.ensureDir(`${buildPath}/codes/`)
        const artifacts: File[] = await buildCodes(projectId, flowVersion)

        for (const artifact of artifacts) {
            await fs.writeFile(`${buildPath}/codes/${artifact.id}.js`, artifact.data)
        }

        await fs.ensureDir(`${buildPath}/flows/`)
        await fs.writeFile(`${buildPath}/flows/${flowVersion.id}.json`, JSON.stringify(flowVersion))

    }
    finally {
        logger.info(`[${flowVersion.id}] Releasing flow lock`)
        await flowLock.release()
    }

}


async function buildCodes(projectId: ProjectId, flowVersion: FlowVersion): Promise<File[]> {
    const buildRequests: Promise<File>[] = []
    const steps = flowHelper.getAllSteps(flowVersion)
    steps.forEach((step) => {
        if (step.type === ActionType.CODE) {
            const codeActionSettings: CodeActionSettings = step.settings
            buildRequests.push(getArtifactFile(projectId, codeActionSettings))
        }
    })
    const files: File[] = await Promise.all(buildRequests)
    if (files.length > 0) {
        await flowVersionService.overwriteVersion(flowVersion.id, flowVersion)
    }
    return files
}

const getArtifactFile = async (projectId: ProjectId, codeActionSettings: CodeActionSettings): Promise<File> => {
    if (codeActionSettings.artifactPackagedId === undefined) {
        logger.info(`Building package for file id ${codeActionSettings.artifactSourceId}`)

        const sourceId = codeActionSettings.artifactSourceId

        if (isNil(sourceId)) {
            throw new ActivepiecesError({
                code: ErrorCode.VALIDATION,
                params: {
                    message: 'artifactSourceId is undefined',
                },
            })
        }

        const fileEntity = await fileService.getOneOrThrow({ projectId: projectId, fileId: sourceId })
        const builtFile = await codeBuilder.build(fileEntity.data)

        const savedPackagedFile = await fileService.save({
            projectId,
            data: builtFile,
        })

        codeActionSettings.artifactPackagedId = savedPackagedFile.id
    }

    const file = await fileService.getOneOrThrow({
        projectId: projectId,
        fileId: codeActionSettings.artifactPackagedId,
    })

    return file
}

export const flowWorker = {
    executeFlow,
}
