import { Link } from 'react-router-dom';
import { formatDueDate, isOverdue, timeAgo } from '../lib/format';
import { itemCode, TYPE_LABEL } from '../lib/labels';
import type { WorkItem } from '../types';
import { PriorityBadge, StatusBadge } from './Badges';

export default function ItemTable({ items }: { items: WorkItem[] }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">ID</th>
            <th scope="col">Title</th>
            <th scope="col">Status</th>
            <th scope="col">Priority</th>
            <th scope="col">Team</th>
            <th scope="col">Assignee</th>
            <th scope="col">Due</th>
            <th scope="col">Updated</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td className="nowrap">{itemCode(item.id)}</td>
              <td>
                <Link to={`/items/${item.id}`} className="item-link">
                  {item.title}
                </Link>
                <div className="muted small">{TYPE_LABEL[item.type]}</div>
              </td>
              <td>
                <StatusBadge status={item.status} />
              </td>
              <td>
                <PriorityBadge priority={item.priority} />
              </td>
              <td>{item.team.name}</td>
              <td>{item.assignee ? item.assignee.name : <span className="muted">Unassigned</span>}</td>
              <td className={isOverdue(item.dueDate, item.status) ? 'overdue nowrap' : 'nowrap'}>
                {formatDueDate(item.dueDate)}
              </td>
              <td className="nowrap muted">{timeAgo(item.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
