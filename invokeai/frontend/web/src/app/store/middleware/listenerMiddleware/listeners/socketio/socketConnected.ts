import { logger } from 'app/logging/logger';
import { $baseUrl } from 'app/store/nanostores/baseUrl';
import { isEqual, size } from 'lodash-es';
import { atom } from 'nanostores';
import { api } from 'services/api';
import { queueApi, selectQueueStatus } from 'services/api/endpoints/queue';
import { receivedOpenAPISchema } from 'services/api/thunks/schema';
import { socketConnected } from 'services/events/actions';

import { startAppListening } from '../..';

const log = logger('socketio');

const $isFirstConnection = atom(true);

export const addSocketConnectedEventListener = () => {
  startAppListening({
    actionCreator: socketConnected,
    effect: async (
      action,
      { dispatch, getState, cancelActiveListeners, delay }
    ) => {
      log.debug('Connected');

      /**
       * The rest of this listener has recovery logic for when the socket disconnects and reconnects.
       *
       * We need to re-fetch if something has changed while we were disconnected. In practice, the only
       * thing that could change while disconnected is a queue item finishes processing.
       *
       * The queue status is a proxy for this - if the queue status has changed, we need to re-fetch
       * the queries that may have changed while we were disconnected.
       */

      // Bail on the recovery logic if this is the first connection - we don't need to recover anything
      if ($isFirstConnection.get()) {
        $isFirstConnection.set(false);
        return;
      }

      // Else, we need to compare the last-known queue status with the current queue status, re-fetching
      // everything if it has changed.

      if ($baseUrl.get()) {
        // If we have a baseUrl (e.g. not localhost), we need to debounce the re-fetch to not hammer server
        cancelActiveListeners();
        // Add artificial jitter to the debounce
        await delay(1000 + Math.random() * 1000);
      }

      const prevQueueStatusData = selectQueueStatus(getState()).data;

      try {
        // Fetch the queue status again
        const queueStatusRequest = dispatch(
          await queueApi.endpoints.getQueueStatus.initiate(undefined, {
            forceRefetch: true,
          })
        );
        const nextQueueStatusData = await queueStatusRequest.unwrap();
        queueStatusRequest.unsubscribe();

        // If the queue hasn't changed, we don't need to do anything.
        if (isEqual(prevQueueStatusData?.queue, nextQueueStatusData.queue)) {
          return;
        }

        //The queue has changed. We need to re-fetch everything that may have changed while we were
        // disconnected.
        dispatch(api.util.invalidateTags(['FetchOnReconnect']));
      } catch {
        // no-op
        log.debug('Unable to get current queue status on reconnect');
      }
    },
  });

  startAppListening({
    actionCreator: socketConnected,
    effect: async (action, { dispatch, getState }) => {
      const { nodeTemplates, config } = getState();
      // We only want to re-fetch the schema if we don't have any node templates
      if (
        !size(nodeTemplates.templates) &&
        !config.disabledTabs.includes('nodes')
      ) {
        // This request is a createAsyncThunk - resetting API state as in the above listener
        // will not trigger this request, so we need to manually do it.
        dispatch(receivedOpenAPISchema());
      }
    },
  });
};
