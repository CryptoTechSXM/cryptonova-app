// Code generated — DO NOT EDIT.
import type { Address } from 'viem'
import { addContractMock, type ContractMock, type EvmMock } from '@chainlink/cre-sdk/test'

import { MatrixKeeperABI } from './MatrixKeeper'

export type MatrixKeeperMock = {
  checkUpkeep?: (arg0: `0x${string}`) => readonly [boolean, `0x${string}`]
} & Pick<ContractMock<typeof MatrixKeeperABI>, 'writeReport'>

export function newMatrixKeeperMock(address: Address, evmMock: EvmMock): MatrixKeeperMock {
  return addContractMock(evmMock, { address, abi: MatrixKeeperABI }) as MatrixKeeperMock
}

