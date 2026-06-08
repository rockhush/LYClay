import { checkDeviceAccess } from '@electron/utils/device-access'

async function main() {
  const result = await checkDeviceAccess({ force: true })
  console.log(result)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})