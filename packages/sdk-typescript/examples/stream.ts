import { Lynxby } from '@lynxby/sdk'

// LYNXBY_TOKEN and LYNXBY_BASE_URL come from the environment.
const lynx = new Lynxby()
const assistant = Number(process.env.LYNXBY_ASSISTANT_ID ?? 1)

// Ctrl+C closes the stream instead of leaving the turn running.
const controller = new AbortController()
process.on('SIGINT', () => controller.abort())

const stream = lynx.agents.stream(assistant, 'Summarise the contract.', { signal: controller.signal })

for await (const event of stream) {
  if (event.event === 'delta') {
    process.stdout.write(event.data.delta)
  }

  if (event.event === 'error') {
    console.error(`\n${event.data.code}: ${event.data.message}`)
  }

  if (event.event === 'done' && 'content' in event.data) {
    console.log(`\n\n${event.data.content}`)
    console.log(`model: ${event.data.model}, cost: ${event.data.cost} ${event.data.currency}`)
  }
}
