#!ts-node

import Koa from 'koa'
import Router from '@koa/router'
import fg from 'fast-glob'
import path from 'path'
import cors from '@koa/cors'
import bodyParser from 'koa-bodyparser'
import logger from 'koa-logger'
import compress from 'koa-compress'
import ratelimit from 'koa-ratelimit'
import cluster from 'cluster'
import os from 'os'
import { exec } from 'child_process'
import serve from 'koa-static'
import session from 'koa-session'
import Redis from 'ioredis'
// import send from 'koa-send'
// import historyFallback from 'koa-connect-history-api-fallback'

const argv = require('yargs/yargs')(process.argv.slice(2)).argv

if (!argv.app_home) {
    argv.app_home = '.'
}

const appHomePath = path.resolve(argv.app_home)
process.chdir(appHomePath)

console.log(appHomePath)

if (!argv.mode) {
    argv.mode = 'development'
}

console.log = console.log.bind(null, 'Flight:')

const redis = new Redis({
    host: process.env.FLIGHT_REDIS_HOST || 'localhost',
    port: Number(process.env.FLIGHT_REDIS_PORT) || 6379
})

if (cluster.isPrimary) {
    const numCPUs = os.cpus().length

    for (let i = 0; i < numCPUs; i++) {
        cluster.fork()
    }

    cluster.on('exit', () => {
        cluster.fork()
    })
} else {
    const app = new Koa()
    app.use(logger())

    app.keys = ['//input example secret key//']

    const SESSION_CONFIG = {
        key: 'flightApp',
        maxAge: 86400000,
        sameSite: true,
        path: '/',
        store: {
            get: async (key: string) => {
                const result = await redis.get(key)
                return result ? JSON.parse(result) : null
            },
            set: async (key: string, value: any, maxAge: number) => {
                await redis.set(key, JSON.stringify(value), 'PX', maxAge)
            },
            destroy: async (key: string) => {
                await redis.del(key)
            }
        }
    }

    app.use(session(SESSION_CONFIG, app))

    const router = new Router()

    app.use(cors()).use(bodyParser())

    const backEndFiles = fg.sync('**/*.backend.ts')
    backEndFiles.forEach((file) => {
        const serverRoutes = require(path.resolve(file))

        console.log('Found backend file: ' + path.resolve(file))

        if (serverRoutes && serverRoutes.default) {
            router.use(serverRoutes.default)
        }
    })

    app.use(router.routes()).use(router.allowedMethods())

    if (argv.mode === 'production') {
        exec('npx vite build', (error, stdout, stderr) => {
            if (error) {
                console.error(`exec error: ${error}`)
                return
            }
            console.log(`stdout: ${stdout}`)
            console.error(`stderr: ${stderr}`)
        })

        app.use(compress())
        app.use(
            ratelimit({
                driver: 'redis',
                db: redis,
                duration: 60000,
                errorMessage: 'Sometimes You Just Have to Slow Down.',
                id: (ctx) => ctx.ip,
                headers: {
                    remaining: 'Rate-Limit-Remaining',
                    reset: 'Rate-Limit-Reset',
                    total: 'Rate-Limit-Total'
                },
                max: 100,
                disableHeader: false
            })
        )
        app.use(serve(process.env.FLIGHT_DIST_PATH || '../dist'))
        console.log('App served out of dist/ and available on port 3000')
    }

    app.listen(3000, () => {
        console.log(`Server worker ${process.pid} started, All backend services are running on port 3000`)
    })

    if (argv.mode === 'development') {
        exec('npx vite', (error, stdout, stderr) => {
            if (error) {
                console.error(`exec error: ${error}`)
                return
            }
            console.log(`stdout: ${stdout}`)
            console.error(`stderr: ${stderr}`)
        })

        console.log(`Vite development server with hot module reload ${process.pid} started on 3001`)
    }
}
