import { ENTITY_TYPE, PRIMARY_KEY, Entity } from '../glossary'
import {
  Database,
  DatabaseEventsMap,
  SerializedEntity,
  SERIALIZED_INTERNAL_PROPERTIES_KEY,
} from '../db/Database'
import { inheritInternalProperties } from '../utils/inheritInternalProperties'

export type DatabaseMessageEventData =
  | {
      operationType: 'create'
      payload: Parameters<DatabaseEventsMap['create']>
    }
  | {
      operationType: 'update'
      payload: Parameters<DatabaseEventsMap['update']>
    }
  | {
      operationType: 'delete'
      payload: Parameters<DatabaseEventsMap['delete']>
    }

function removeListeners<Event extends keyof DatabaseEventsMap>(
  event: Event,
  db: Database<any>,
) {
  const listeners = db.events.listeners(event) as DatabaseEventsMap[Event][]

  listeners.forEach((listener) => {
    db.events.removeListener(event, listener)
  })

  return () => {
    listeners.forEach((listener) => {
      db.events.addListener(event, listener)
    })
  }
}

/**
 * Sets the serialized internal properties as symbols
 * on the given entity.
 * @note `Symbol` properties are stripped off when sending
 * an object over an event emitter.
 */
function deserializeEntity(entity: SerializedEntity): Entity<any, any> {
  const {
    [SERIALIZED_INTERNAL_PROPERTIES_KEY]: internalProperties,
    ...publicProperties
  } = entity

  inheritInternalProperties(publicProperties, {
    [ENTITY_TYPE]: internalProperties.entityType,
    [PRIMARY_KEY]: internalProperties.primaryKey,
  })

  return publicProperties
}

/**
 * Synchronizes database operations across multiple clients.
 */
export function sync(db: Database<any>) {
  const IS_BROWSER = typeof window !== 'undefined'
  const SUPPORTS_BROADCAST_CHANNEL = typeof BroadcastChannel !== 'undefined'

  if (!IS_BROWSER || !SUPPORTS_BROADCAST_CHANNEL) {
    return
  }

  const channel = new BroadcastChannel('mswjs/data/sync')

  channel.addEventListener(
    'message',
    (event: MessageEvent<DatabaseMessageEventData>) => {
      const [sourceId] = event.data.payload

      // Ignore messages originating from unrelated databases.
      // Useful in case of multiple databases on the same page.
      if (db.id !== sourceId) {
        return
      }

      // Remove database event listener for the signaled operation
      // to prevent an infinite loop when applying this operation.
      const restoreListeners = removeListeners(event.data.operationType, db)

      // Apply the database operation signaled from another client
      // to the current database instance.
      switch (event.data.operationType) {
        case 'create': {
          const [modelName, entity, customPrimaryKey] = event.data.payload[1]
          db.create(modelName, deserializeEntity(entity), customPrimaryKey)
          break
        }

        case 'update': {
          const [modelName, prevEntity, nextEntity] = event.data.payload[1]
          db.update(
            modelName,
            deserializeEntity(prevEntity),
            deserializeEntity(nextEntity),
          )
          break
        }

        default: {
          db[event.data.operationType](...event.data.payload[1])
        }
      }

      // Re-attach database event listeners.
      restoreListeners()
    },
  )

  // Broadcast the emitted event from this client
  // to all the other connected clients.
  function broadcastDatabaseEvent<Event extends keyof DatabaseEventsMap>(
    operationType: Event,
  ) {
    return (...payload: Parameters<DatabaseEventsMap[Event]>) => {
      channel.postMessage({
        operationType,
        payload,
      } as DatabaseMessageEventData)
    }
  }

  db.events.on('create', broadcastDatabaseEvent('create'))
  db.events.on('update', broadcastDatabaseEvent('update'))
  db.events.on('delete', broadcastDatabaseEvent('delete'))
}
