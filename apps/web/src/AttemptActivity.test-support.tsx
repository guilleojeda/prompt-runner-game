import { forwardRef, useImperativeHandle } from 'react';
import {
  useAttemptActivity,
  type AttemptActivityHandle,
  type AttemptActivityOptions,
} from './useAttemptActivity.js';

/**
 * Mounts the real activity owner and controls in isolation. The shell supplies only the editor's
 * semantic Probar action; admission, recovery, polling, presentation and history stay in product
 * components.
 */
export const AttemptActivityHarness = forwardRef<AttemptActivityHandle, AttemptActivityOptions>(
  function AttemptActivityHarness(props, ref) {
    const activity = useAttemptActivity(props);
    useImperativeHandle(ref, () => ({ start: activity.start }), [activity.start]);

    return (
      <>
        {activity.controls}
        {activity.view}
        {activity.historyView}
        {activity.historyResultView}
        {activity.configurationView}
        {activity.inspectorView}
      </>
    );
  },
);
