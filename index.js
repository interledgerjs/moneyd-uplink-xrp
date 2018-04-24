'use strict'
const crypto = require('crypto')
const fetch = require('node-fetch')
const { RippleAPI } = require('ripple-lib')
const table = require('good-table')
const chalk = require('chalk')
const moment = require('moment')
const Plugin = require('ilp-plugin-xrp-asym-client')
const { createSubmitter } = require('ilp-plugin-xrp-paychan-shared')
const connectorList = require('./connector_list.json')
const parentBtpHmacKey = 'parent_btp_uri'
const DEFAULT_RIPPLED = 'wss://s1.ripple.com'
const DEFAULT_TESTNET_RIPPLED = 'wss://s.altnet.rippletest.net:51233'

class XrpUplink {
  constructor (config) {
    this.config = config
    this.pluginOpts = config.options
    this.api = null
    this.subscribed = false
  }

  static async buildConfig (inquirer, { testnet }) {
    const servers = connectorList[testnet ? 'test' : 'live']
    const defaultParent = servers[Math.floor(Math.random() * servers.length)]
    const res = await inquirer.prompt([{
      type: 'input',
      name: 'parent',
      message: 'BTP host of parent connector:',
      default: defaultParent
    }, {
      type: 'input',
      name: 'name',
      message: 'Name to assign to this channel. Must be changed if other parameters are changed.',
      default: ''
    }, {
      type: 'input',
      name: 'secret',
      message: 'XRP secret' + (testnet ? ' (optional):' : ':'),
      // Secret is optional when testnet is set.
      validate: (secret) => testnet || secret.length !== 0
    }, {
      type: 'input',
      name: 'address',
      message: 'XRP address (optional):'
    }, {
      type: 'input',
      name: 'xrpServer',
      message: 'Rippled server:',
      default: testnet ? DEFAULT_TESTNET_RIPPLED : DEFAULT_RIPPLED
    }])

    const btpName = res.name || ''
    const btpSecret = hmac(hmac(parentBtpHmacKey, res.parent + btpName), res.secret).toString('hex')
    const btpServer = 'btp+wss://' + btpName + ':' + btpSecret + '@' + res.parent
    if (testnet && !res.secret) {
      console.log('acquiring testnet account...')
      const res = await fetch('https://faucet.altnet.rippletest.net/accounts', { method: 'POST' })
      const json = await res.json()

      res.address = json.account.address
      res.secret = json.account.secret
      console.log('got testnet address "' + res.address + '"')
      console.log('waiting for testnet API to fund address...')
      await new Promise(resolve => setTimeout(resolve, 10000))
    }
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
      options: {
        server: btpServer,
        secret: res.secret,
        address: res.address || undefined,
        xrpServer: res.xrpServer
      }
    }
  }

  getPlugin () { return new Plugin(this.pluginOpts) }

  async listChannels () {
    const api = await this._rippleApi()
    console.log('fetching channels...')
    const res = await api.connection.request({
      command: 'account_channels',
      account: this.pluginOpts.address
    })
    return res.channels
  }

  async printChannels (channels) {
    console.log('connecting to xrp ledger...')
    const api = await this._rippleApi()
    const res = await api.getAccountInfo(this.pluginOpts.address)
    console.log(chalk.green('account:'), this.pluginOpts.address)
    console.log(chalk.green('balance:'), res.xrpBalance + ' XRP')
    console.log(table([
      [ chalk.green('index'),
        chalk.green('destination'),
        chalk.green('amount (drops)'),
        chalk.green('balance (drops)'),
        chalk.green('expiry') ],
      ...channels.map(formatChannelToRow)
    ]))
  }

  async cleanupChannels (channels) {
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
    c.destination_account,
    c.amount,
    c.balance,
    formatChannelExpiration(c.expiration)
  ]
}

function hmac (key, message) {
  const h = crypto.createHmac('sha256', key)
  h.update(message)
  return h.digest()
}

module.exports = XrpUplink
