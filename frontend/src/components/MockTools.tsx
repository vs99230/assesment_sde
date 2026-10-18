import { useState } from 'react';
import { mockTools } from '../api/mock/mockApi';
import { itemCode } from '../lib/labels';

/** Mock mode only: lets you rehearse the "someone else changed this" conflict flow. */
export default function MockTools({ itemId }: { itemId: number }) {
  const [done, setDone] = useState(false);

  return (
    <div className="card mock-tools">
      <h2>Demo tools</h2>
      <p className="muted small">
        Pretend another user just edited {itemCode(itemId)} behind this screen’s back, then try Claim, a workflow
        button, or Save changes to see the conflict message.
      </p>
      <button
        type="button"
        className="btn btn-small"
        onClick={() => setDone(mockTools.simulateExternalChange(itemId))}
      >
        Simulate edit by another user
      </button>
      {done && <p className="small success-text">Done. This screen is now out of date on purpose.</p>}
    </div>
  );
}
