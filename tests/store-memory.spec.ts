import { createMemoryStore } from '../src/store/memory.ts'
import { storeContract } from './store-contract.ts'

storeContract('memory store', async () => createMemoryStore())
