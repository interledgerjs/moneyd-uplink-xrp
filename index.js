'use strict'
const crypto = require('crypto')
const fetch = require('node-fetch')
const { RippleAPI } = require('ripple-lib')
const { isValidSeed } = require('ripple-address-codec')
const { deriveKeypair, deriveAddress } = require('ripple-keypairs')
const table = require('good-table')
const chalk = require('chalk')
const inquirer = require('inquirer')
const moment = require('moment')
const Plugin = require('ilp-plugin-xrp-asym-client')
const { createSubmitter } = require('ilp-plugin-xrp-paychan-shared')
const connectorList = require('./connector_list.json')
const parentBtpHmacKey = 'parent_btp_uri'
const rippledList = require('./rippled_list.json')
const base64url = buf => buf
  .toString('base64')
  .replace(/=/g, '')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')

async function configure ({ testnet, advanced }) {
  const servers = connectorList[testnet ? 'test' : 'live']
  const defaultParent = servers[Math.floor(Math.random() * servers.length)]
  const rippledServers = rippledList[testnet ? 'test' : 'live']
  const defaultRippled = rippledServers[Math.floor(Math.random() * rippledServers.length)]
  const res = {}
  const fields = [{
    type: 'input',
    name: 'parent',
    message: 'BTP host of parent connector:',
    default: defaultParent
  }, {
    type: 'input',
    name: 'name',
    message: 'Name to assign to this channel:',
    default: base64url(crypto.randomBytes(32))
  }, {
    type: 'input',
    name: 'secret',
    message: 'XRP secret' + (testnet ? ' (optional):' : ':'),
    default: testnet ? '' : undefined,
    validate: (secret) => (testnet && secret.length === 0) || isValidSeed(secret)
  }, {
    type: 'input',
    name: 'xrpServer',
    message: 'Rippled server:',
    default: defaultRippled
  }]
  for (const field of fields) {
    if (advanced || field.default === undefined) {
      res[field.name] = (await inquirer.prompt(field))[field.name]
    } else {
      res[field.name] = field.default
    }
  }

  if (testnet && !res.secret) {
    console.log('acquiring testnet account...')
    const resp = await fetch('https://faucet.altnet.rippletest.net/accounts', { method: 'POST' })
    const json = await resp.json()

    res.address = json.account.address
    res.secret = json.account.secret
    console.log('got testnet address "' + res.address + '"')
    console.log('waiting for testnet API to fund address...')
    await new Promise(resolve => setTimeout(resolve, 10000))
  } else {
    if (!res.address) {
      res.address = deriveAddress(deriveKeypair(res.secret).publicKey)
    }
    // Ensure that the given account exists and has enough XRP to create a channel.
    await validateAddress(res.xrpServer, res.address).catch((err) => {
      console.error('Error configuring uplink: ' + err.message)
      process.exit(1)
    })
  }
  const btpName = res.name || ''
  const btpSecret = hmac(hmac(parentBtpHmacKey, res.parent + btpName), res.secret).toString('hex')
  const btpServer = 'btp+wss://' + btpName + ':' + btpSecret + '@' + res.parent
  return {
    relation: 'parent',
    plugin: require.resolve('ilp-plugin-xrp-asym-client'),
    assetCode: 'XRP',
    assetScale: 6,
    balance: {
      minimum: '-Infinity',
      maximum: '20000',
      settleThreshold: '5000',
      settleTo: '10000'
    },
    sendRoutes: false,
    receiveRoutes: false,
    options: {
      server: btpServer,
      secret: res.secret,
      address: res.address,
      xrpServer: res.xrpServer
    }
  }
}

const commands = [
  {
    command: 'info',
    describe: 'Get info about your XRP account and payment channels',
    builder: {},
    handler: (config, argv) => makeUplink(config).printChannels()
  },
  {
    command: 'cleanup',
    describe: 'Clean up unused payment channels',
    builder: {},
    handler: (config, argv) => makeUplink(config).cleanupChannels()
  },
  {
    command: 'topup',
    describe: 'Pre-fund your balance with connector',
    builder: {
      amount: {
        description: 'amount to send to connector',
        demandOption: true
      }
    },
    handler: (config, { amount }) => makeUplink(config).topup(amount)
  }
]

function makeUplink (config) {
  return new XrpUplink(config)
}

class XrpUplink {
  constructor (config) {
    this.config = config
    this.pluginOpts = config.options
    this.api = null
    this.subscribed = false
  }

  async printChannels () {
    await this._printChannels(await this._listChannels())
  }

  async _printChannels (channels) {
    console.log('connecting to xrp ledger...')
    const api = await this._rippleApi()
    const res = await api.getAccountInfo(this.pluginOpts.address)
    const serverInfo = await api.getServerInfo()
    const reserveBase = Number(serverInfo.validatedLedger.reserveBaseXRP)
    const reserveInc = Number(serverInfo.validatedLedger.reserveIncrementXRP)
    const reserved = Number(res.ownerCount) * reserveInc + reserveBase
    console.log(chalk.green('account:'), this.pluginOpts.address)
    console.log(chalk.green('balance:'), res.xrpBalance + ' XRP')
    console.log(chalk.yellow('  reserved:'), String(reserved) + ' XRP')
    console.log(chalk.yellow('  available:'), (Number(res.xrpBalance) - reserved) + ' XRP')
    console.log()
    if (!channels.length) {
      return console.error('No channels found')
    }

    console.log(table([
      [ chalk.green('index'),
        chalk.green('channel id'),
        chalk.green('destination'),
        chalk.green('amount (drops)'),
        chalk.green('balance (drops)'),
        chalk.green('expiry') ],
      ...channels.map(formatChannelToRow)
    ]))
  }

  async cleanupChannels () {
    const allChannels = await this._listChannels()
    await this._printChannels(allChannels)
    if (!allChannels.length) return
    const result = await inquirer.prompt({
      type: 'checkbox',
      name: 'marked',
      message: 'Select channels to close:',
      choices: allChannels.map((_, i) => i.toString())
    })
    const channels = result.marked.map((index) => allChannels[+index])

    const submitter = await this._submitter()
    for (const channel of channels) {
      const channelId = channel.channel_id
      console.log('Closing channel ' + channelId)
      try {
        await submitter.submit('preparePaymentChannelClaim', {
          channel: channelId,
          close: true
        })
      } catch (err) {
        console.error('Warning for channel ' + channelId + ':', err.message)
      }
    }
  }

  async _listChannels () {
    const api = await this._rippleApi()
    console.log('fetching channels...')
    const res = await api.connection.request({
      command: 'account_channels',
      account: this.pluginOpts.address
    })
    return res.channels
  }

  async topup (amount) {
    const plugin = new Plugin(this.pluginOpts)
    await plugin.connect()
    await plugin.sendMoney(amount)
  }

  async _rippleApi () {
    if (!this.api) {
      this.api = new RippleAPI({ server: this.pluginOpts.xrpServer })
      await this.api.connect()
    }
    return this.api
  }

  async _submitter () {
    const api = await this._rippleApi()

    if (!this.subscribed) {
      this.subscribed = true
      await api.connection.request({
        command: 'subscribe',
        accounts: [ this.pluginOpts.address ]
      })
    }

    return createSubmitter(api, this.pluginOpts.address, this.pluginOpts.secret)
  }
}

function formatChannelExpiration (exp) {
  if (!exp) return ''
  const unixExp = (exp + 0x386D4380) * 1000
  if (unixExp <= Date.now()) return chalk.blue('ready to close')
  return chalk.yellow('in ' + moment.duration(unixExp - Date.now()).humanize())
}

function formatChannelToRow (c, i) {
  return [
    String(i),
    c.channel_id.substring(0, 8) + '...',
    c.destination_account,
    comma(c.amount),
    comma(c.balance),
    formatChannelExpiration(c.expiration)
  ]
}

async function validateAddress (server, address) {
  const api = new RippleAPI({ server })
  await api.connect()
  const accountInfo = await api.getAccountInfo(address).catch((err) => {
    if (err.message !== 'actNotFound') throw err
    throw new Error('Address "' + address + '" does not exist on ' + server)
  })
  const { validatedLedger: {
    reserveBaseXRP,
    reserveIncrementXRP
  } } = await api.getServerInfo()

  const minBalance = (+reserveBaseXRP) + (+reserveIncrementXRP) * accountInfo.ownerCount + // total current reserve
    (+reserveIncrementXRP) + // reserve for the channel
    (+Plugin.OUTGOING_CHANNEL_DEFAULT_AMOUNT) +
    1 // extra to cover channel create fee
  const currentBalance = +accountInfo.xrpBalance
  if (currentBalance < minBalance) {
    throw new Error('account balance is too low (must be at least ' + minBalance + ')')
  }
}

function comma (a) {
  return a
    .split('')
    .map((e, i) => {
      if ((a.length - i) % 3 === 1 && i < a.length - 1) {
        return e + ','
      } else {
        return e
      }
    })
    .join('')
}

function hmac (key, message) {
  const h = crypto.createHmac('sha256', key)
  h.update(message)
  return h.digest()
}

module.exports = {
  configure,
  commands
}
