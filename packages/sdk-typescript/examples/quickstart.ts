import { Lynxby } from '@lynxby/sdk'

const lynx = new Lynxby()
const run = await lynx.tasks.run(8, { text: 'A long letter.' })
console.log(run.answer)
