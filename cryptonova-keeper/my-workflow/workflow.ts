import {
	bytesToHex,
	hexToBase64,
	cre,
	getNetwork,
	TxStatus,
	type Runtime,
} from '@chainlink/cre-sdk'
import { type Address } from 'viem'
import { z } from 'zod'
import { MatrixKeeper } from '../contracts/evm/ts/generated/MatrixKeeper'

// ─── Config Schema ──────────────────────────────────────────
// matrixKeeperAddress = read target (checkUpkeep)
// receiverAddress     = write target (MatrixKeeperReceiver.onReport -> performUpkeep)
export const configSchema = z.object({
	schedule: z.string(),
	evms: z.array(
		z.object({
			chainSelectorName: z.string(),
			matrixKeeperAddress: z.string(),
			receiverAddress: z.string(),
			gasLimit: z.string().optional(),
		}),
	),
})
type Config = z.infer<typeof configSchema>

// ─── Callback ───────────────────────────────────────────────
export const onCronTrigger = (runtime: Runtime<Config>): string => {
	const evmConfig = runtime.config.evms[0]

	// 1. Get network and create EVM client
	const network = getNetwork({
		chainFamily: 'evm',
		chainSelectorName: evmConfig.chainSelectorName,
		isTestnet: true,
	})
	if (!network) throw new Error(`Network not found: ${evmConfig.chainSelectorName}`)

	const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector)
	const matrixKeeper = new MatrixKeeper(evmClient, evmConfig.matrixKeeperAddress as Address)

	// 2. Read upkeep state directly from MatrixKeeper.
	//    checkUpkeep's bytes input is unused by the contract (unnamed param) — pass empty bytes.
	const [upkeepNeeded, performData] = matrixKeeper.checkUpkeep(runtime, '0x')

	runtime.log(`Upkeep needed: ${upkeepNeeded}`)

	if (!upkeepNeeded) {
		runtime.log('No upkeep needed. Skipping execution.')
		return 'Skipped — no upkeep needed'
	}

	runtime.log(`performData: ${performData}`)

	// 3. Relay performData to MatrixKeeperReceiver via a signed CRE report.
	//    MatrixKeeperReceiver.onReport(metadata, report) forwards `report` byte-for-byte
	//    into MatrixKeeper.performUpkeep(report) — performData is used as-is, no
	//    additional ABI-encoding needed since it was already encoded on-chain by
	//    MatrixKeeper.checkUpkeep() itself.
	const reportResponse = runtime
		.report({
			encodedPayload: hexToBase64(performData),
			encoderName: 'evm',
			signingAlgo: 'ecdsa',
			hashingAlgo: 'keccak256',
		})
		.result()

	const writeResult = evmClient
		.writeReport(runtime, {
			receiver: evmConfig.receiverAddress as Address,
			report: reportResponse,
			gasConfig: { gasLimit: evmConfig.gasLimit ?? '5000000' },
		})
		.result()

	if (writeResult.txStatus !== TxStatus.SUCCESS) {
		throw new Error(`Keeper TX failed: ${writeResult.errorMessage || writeResult.txStatus}`)
	}

	const txHash = bytesToHex(writeResult.txHash || new Uint8Array(32))
	runtime.log(`MatrixKeeper upkeep relayed via receiver. TX: ${txHash}`)

	return `Executed — tx: ${txHash}`
}

// ─── Workflow Init ──────────────────────────────────────────
export function initWorkflow(config: Config) {
	const cronTrigger = new cre.capabilities.CronCapability()

	return [
		cre.handler(
			cronTrigger.trigger({ schedule: config.schedule }),
			onCronTrigger,
		),
	]
}
