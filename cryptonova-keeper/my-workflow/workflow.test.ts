import { describe, expect } from 'bun:test'
import { TxStatus } from '@chainlink/cre-sdk'
import { EvmMock, newTestRuntime, test } from '@chainlink/cre-sdk/test'
import type { Address } from 'viem'
import { newMatrixKeeperMock } from '../contracts/evm/ts/generated/MatrixKeeper_mock'
import { initWorkflow, onCronTrigger } from './workflow'

const CHAIN_SELECTOR = 10344971235874465080n // ethereum-testnet-sepolia-base-1 (Base Sepolia)
const MATRIX_KEEPER_ADDRESS = '0xc85A54319ec73e51F9Ad3033068c373e773312fb' as Address
const RECEIVER_ADDRESS = '0x2dEb3BCEBDB4d906356B400C098a9eE964bF1CBe' as Address

const makeConfig = () => ({
	schedule: '0 */5 * * * *',
	evms: [
		{
			chainSelectorName: 'ethereum-testnet-sepolia-base-1',
			matrixKeeperAddress: MATRIX_KEEPER_ADDRESS,
			receiverAddress: RECEIVER_ADDRESS,
		},
	],
})

describe('onCronTrigger', () => {
	test('relays performData to the receiver when checkUpkeep says upkeep is needed', async () => {
		const evmMock = EvmMock.testInstance(CHAIN_SELECTOR)
		const keeperMock = newMatrixKeeperMock(MATRIX_KEEPER_ADDRESS, evmMock)

		const performData = '0x1234' as const
		keeperMock.checkUpkeep = () => [true, performData] as const

		evmMock.writeReport = () => ({
			txStatus: TxStatus.SUCCESS,
			txHash: new Uint8Array(32),
		})

		const runtime = newTestRuntime()
		;(runtime as any).config = makeConfig()

		const result = onCronTrigger(runtime as any)
		expect(result).toContain('Executed')
	})

	test('skips execution when checkUpkeep says no upkeep is needed', async () => {
		const evmMock = EvmMock.testInstance(CHAIN_SELECTOR)
		const keeperMock = newMatrixKeeperMock(MATRIX_KEEPER_ADDRESS, evmMock)

		keeperMock.checkUpkeep = () => [false, '0x'] as const

		const runtime = newTestRuntime()
		;(runtime as any).config = makeConfig()

		const result = onCronTrigger(runtime as any)
		expect(result).toContain('Skipped')
	})
})

describe('initWorkflow', () => {
	test('returns a handler subscribed to cron trigger', () => {
		const config = makeConfig()
		const handlers = initWorkflow(config)

		expect(handlers).toHaveLength(1)
		expect(handlers[0].fn).toBe(onCronTrigger)

		const cronTrigger = handlers[0].trigger as { config?: { schedule?: string } }
		expect(cronTrigger.config?.schedule).toBe(config.schedule)
	})
})
