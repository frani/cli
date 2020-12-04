'use strict'

const { once, EventEmitter } = require('events')

const bastion = require('./bastion')
const debug = require('./debug')

function psqlQueryOptions (query, dbEnv) {
  debug('Running query: %s', query.trim())

  const psqlArgs = ['-c', query, '--set', 'sslmode=require']

  const childProcessOptions = {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit']
  }

  return {
    dbEnv,
    psqlArgs,
    childProcessOptions,
    pipeToStdout: true
  }
}

function psqlFileOptions (file, dbEnv) {
  debug('Running sql file: %s', file.trim())

  const childProcessOptions = {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit']
  }

  const psqlArgs = ['-f', file, '--set', 'sslmode=require']

  return {
    dbEnv,
    psqlArgs,
    childProcessOptions,
    pipeToStdout: true
  }
}

function psqlInteractiveOptions (prompt, dbEnv) {
  let psqlArgs = ['--set', `PROMPT1=${prompt}`, '--set', `PROMPT2=${prompt}`]
  let psqlHistoryPath = process.env.HEROKU_PSQL_HISTORY
  if (psqlHistoryPath) {
    const fs = require('fs')
    const path = require('path')
    if (fs.existsSync(psqlHistoryPath) && fs.statSync(psqlHistoryPath).isDirectory()) {
      let appLogFile = `${psqlHistoryPath}/${prompt.split(':')[0]}`
      debug('Logging psql history to %s', appLogFile)
      psqlArgs = psqlArgs.concat(['--set', `HISTFILE=${appLogFile}`])
    } else if (fs.existsSync(path.dirname(psqlHistoryPath))) {
      debug('Logging psql history to %s', psqlHistoryPath)
      psqlArgs = psqlArgs.concat(['--set', `HISTFILE=${psqlHistoryPath}`])
    } else {
      const cli = require('heroku-cli-util')
      cli.warn(`HEROKU_PSQL_HISTORY is set but is not a valid path (${psqlHistoryPath})`)
    }
  }
  psqlArgs = psqlArgs.concat(['--set', 'sslmode=require'])

  const childProcessOptions = {
    stdio: 'inherit'
  }

  return {
    dbEnv,
    psqlArgs,
    childProcessOptions
  }
}

function execPSQL ({ dbEnv, psqlArgs, childProcessOptions, pipeToStdout }) {
  const { spawn } = require('child_process')

  const options = {
    env: dbEnv,
    ...childProcessOptions
  }

  debug('opening psql process')
  const psql = spawn('psql', psqlArgs, options)
  psql.once('spawn', () => debug('psql process spawned'))

  if (pipeToStdout) {
    psql.stdout.pipe(process.stdout)
  }

  return psql
}

async function waitForPSQLExit (psql) {
  try {
    const exitCode = await once(psql, 'close')
    if (exitCode > 0) {
      throw new Error(`psql exited with code ${exitCode}`)
    }
  } catch (err) {
    debug('psql process error', err)
    let error = err

    if (error.code === 'ENOENT') {
      error = new Error(`The local psql command could not be located. For help installing psql, see https://devcenter.heroku.com/articles/heroku-postgresql#local-setup`)
    }

    throw error
  }
}

// According to node.js docs, sending a kill to a process won't cause an error
// but could have unintended consequences if the PID gets reassigned:
// https://nodejs.org/docs/latest-v14.x/api/child_process.html#child_process_subprocess_kill_signal
// To be on the safe side, check if the process was already killed before sending the signal
function kill (childProcess, signal) {
  if (!childProcess.killed) {
    psql('killing psql child process')
    childProcess.kill(signal)
  }
}

// trap SIGINT so that ctrl+c can be used by psql without killing the
// parent node process.
// you can use ctrl+c in psql to kill running queries
const trapAndForwardSignalsToChildProcess = (childProcess) => {
  const signalsToTrap = ['SIGINT']
  const signalTraps = signalsToTrap.map((signal) => {
    process.removeAllListeners(signal);
    const listener = () => kill(childProcess, signal)
    process.on(signal, listener)
    return [signal, listener]
  });

  // restores the built-in node ctrl+c and other handlers
  const cleanup = () => {
    signalTraps.forEach(([signal, listener]) => {
      process.removeListener(signal, listener)
    })
  }

  return cleanup
}

async function runWithTunnel (db, tunnelConfig, options) {
  const tunnel = await Tunnel.connect(db, tunnelConfig)
  debug('after create tunnel')

  const psql = execPSQL(options)
  const cleanupSignalTraps = trapAndForwardSignalsToChildProcess(psql)

  try {
    debug('waiting for psql or tunnel to exit')
    // wait for either psql or tunnel to exit;
    // the important bit is that we ensure both processes are
    // always cleaned up in the `finally` block below
    await Promise.race([
      waitForPSQLExit(psql),
      tunnel.waitForClose()
    ])
  } catch (err) {
    debug('wait for psql or tunnel error', err)
    throw err
  } finally {
    debug('begin tunnel cleanup')
    cleanupSignalTraps()
    tunnel.close()
    kill(psql, 'SIGKILL')
    debug('end tunnel cleanup')
  }
}

// a small wrapper around tunnel-ssh
// so that other code doesn't have to worry about
// whether there is or is not a tunnel
class Tunnel {
  constructor (bastionTunnel) {
    this.bastionTunnel = bastionTunnel
    this.events = new EventEmitter()
  }

  async waitForClose () {
    if (this.bastionTunnel) {
      try {
        debug('wait for tunnel close')
        await once(this.bastionTunnel, 'close')
        debug('tunnel closed')
      } catch (err) {
        debug('tunnel close error', err)
        throw new Error('Secure tunnel to your database failed')
      }
    } else {
      debug('no bastion required; waiting for fake close event')
      await once(this.events, 'close')
    }
  }

  close () {
    if (this.bastionTunnel) {
      debug('close tunnel')
      this.bastionTunnel.close()
    } else {
      debug('no tunnel necessary; sending fake close event')
      this.events.emit('close', 0)
    }
  }

  static async connect (db, tunnelConfig) {
    const tunnel = await bastion.sshTunnel(db, tunnelConfig)
    return new Tunnel(tunnel)
  }
}

async function exec (db, query) {
  const configs = bastion.getConfigs(db)
  const options = psqlQueryOptions(query, configs.dbEnv)

  return runWithTunnel(db, configs.dbTunnelConfig, options)
}

async function execFile (db, file) {
  const configs = bastion.getConfigs(db)
  const options = psqlFileOptions(file, configs.dbEnv)

  return runWithTunnel(db, configs.dbTunnelConfig, options)
}

async function interactive (db) {
  const name = db.attachment.name
  const prompt = `${db.attachment.app.name}::${name}%R%# `
  const configs = bastion.getConfigs(db)
  configs.dbEnv.PGAPPNAME = 'psql interactive' // default was 'psql non-interactive`
  const options = psqlInteractiveOptions(prompt, configs.dbEnv)

  return runWithTunnel(db, configs.dbTunnelConfig, options)
}

module.exports = {
  exec,
  execFile,
  interactive,
}
