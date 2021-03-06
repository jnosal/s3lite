const sqlite3 = require('sqlite3')
const Queue = require('./queue')
const { now, removeFile } = require('./utils')

module.exports = function ({ s3, autoRollbackOnError }) {
  const Executor = {}

  const queue = new Queue()
  let insideTransaction = false
  let sqliteInstance
  let sqliteInstanceLocalFile

  function isSelect (sql) {
    return /^select/i.test(sql.trim())
  }

  function isBegin (sql) {
    return /^begin/i.test(sql.trim())
  }

  function isCommit (sql) {
    return /^commit/i.test(sql.trim())
  }

  function isRollback (sql) {
    return /^rollback/i.test(sql.trim())
  }

  function openDatabase (useCache = true) {
    return new Promise((resolve, reject) => {
      s3.pullDatabase(useCache)
        .then(localFile => {
          sqliteInstanceLocalFile = localFile
          if (sqliteInstance) {
            resolve(sqliteInstance)
          } else {
            sqliteInstance = new sqlite3.Database(localFile, error => {
              if (error) {
                reject(error)
              } else {
                resolve(sqliteInstance)
              }
            })
          }
        })
        .catch(error => reject(error))
    })
  }

  function executeSql ({ method, sql, params }) {
    return new Promise((resolve, reject) => {
      try {
        const fnParams = [sql]
        if (method !== 'exec') {
          fnParams.push(params)
        }
        fnParams.push(function (error, result) {
          if (error) {
            reject(error)
          } else {
            resolve({
              instance: this,
              result,
              sql
            })
          }
        })

        sqliteInstance[method](...fnParams)
      } catch (error) {
        reject(error)
      }
    })
  }

  function executeStatement ({ method, statement, params }) {
    return new Promise((resolve, reject) => {
      try {
        statement[method](params, (error, result) => {
          if (error) {
            reject(error)
          } else {
            resolve({
              instance: statement,
              result
            })
          }
        })
      } catch (error) {
        reject(error)
      }
    })
  }

  Executor.open = () => {
    const queueGroup = now() + Math.random()
    return queue.enqueue(queueGroup, () => openDatabase())
  }

  Executor.close = () => {
    const queueGroup = now() + Math.random()
    const promises = []
    if (!sqliteInstance) {
      promises.push(queue.enqueue(queueGroup, () => openDatabase()))
    }
    const result = queue.enqueue(
      queueGroup,
      () =>
        new Promise((resolve, reject) => {
          sqliteInstance.close(error => {
            if (error) {
              reject(error)
            } else {
              sqliteInstance = null
              resolve()
            }
          })
        })
    )
    promises.push(result)
    promises.push(
      queue.enqueue(queueGroup, () =>
        removeFile(sqliteInstanceLocalFile).catch(() => {})
      )
    )
    return Promise.all(promises).then(() => result)
  }

  Executor.prepare = ({ sql, params }) => {
    const queueGroup = now() + Math.random()
    const promises = []
    if (!sqliteInstance) {
      promises.push(queue.enqueue(queueGroup, () => openDatabase()))
    }
    let statement
    const result = queue.enqueue(
      queueGroup,
      () =>
        new Promise((resolve, reject) => {
          params =
            params.length !== 1 ||
            (!Array.isArray(params[0]) && typeof params[0] !== 'object')
              ? params
              : params[0]
          statement = sqliteInstance.prepare(sql, params, error => {
            if (error) {
              reject(error)
            } else {
              resolve(true)
            }
          })
        })
    )
    promises.push(result)
    return Promise.all(promises).then(() => statement)
  }

  Executor.exec = ({ method, sql, statement, params = [], counter = 0 }) => {
    sql = statement ? statement.sql : sql
    params =
      params.length !== 1 ||
      (!Array.isArray(params[0]) && typeof params[0] !== 'object')
        ? params
        : params[0]
    const queueGroup = now() + Math.random()
    const promises = []

    if (!insideTransaction) {
      if (!isSelect(sql)) {
        promises.push(queue.enqueue(queueGroup, () => s3.acquireLock()))
        if (isBegin(sql)) {
          insideTransaction = true
        }
      }
      promises.push(
        queue.enqueue(queueGroup, () => openDatabase(isSelect(sql)))
      )
    }

    const result = statement
      ? queue.enqueue(queueGroup, () =>
        executeStatement({ method, statement, params })
      )
      : queue.enqueue(queueGroup, () => executeSql({ method, sql, params }))
    promises.push(result)

    if (!isSelect(sql)) {
      if (!insideTransaction || isCommit(sql)) {
        promises.push(queue.enqueue(queueGroup, () => s3.pushDatabase()))
        promises.push(queue.enqueue(queueGroup, () => s3.releaseLock()))
        insideTransaction = false
      } else if (insideTransaction && isRollback(sql)) {
        promises.push(queue.enqueue(queueGroup, () => s3.releaseLock()))
        insideTransaction = false
      }
    }

    // const newQueueGroup = now() + Math.random()
    // queue.enqueue(newQueueGroup, () => checkIfItsOk(promises))

    return Promise.all(promises).then(() => result)
  }

  return Executor
}
