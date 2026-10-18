import { useState, type FormEvent } from 'react';
import { errorMessage } from '../api/errors';
import { useAddComment } from '../hooks/queries';
import { validateComment } from '../lib/validation';

export default function CommentBox({ itemId }: { itemId: number }) {
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const add = useAddComment(itemId);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (add.isPending) return;
    const found = validateComment(text);
    setProblem(found);
    if (found) return;
    add.mutate(text.trim(), {
      onSuccess: () => setText(''),
      onError: (err) => setProblem(errorMessage(err)),
    });
  };

  return (
    <form onSubmit={onSubmit} className="comment-form" noValidate>
      <label htmlFor="comment">Add a comment</label>
      <textarea
        id="comment"
        rows={3}
        value={text}
        maxLength={2000}
        onChange={(e) => setText(e.target.value)}
        aria-invalid={!!problem}
        aria-describedby={problem ? 'comment-err' : undefined}
      />
      {problem && (
        <p id="comment-err" className="field-error">
          {problem}
        </p>
      )}
      <button type="submit" className="btn" disabled={add.isPending}>
        {add.isPending ? 'Posting…' : 'Post comment'}
      </button>
    </form>
  );
}
