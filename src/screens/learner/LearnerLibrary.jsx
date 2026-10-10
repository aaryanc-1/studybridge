import { useState } from 'react';
import { useApp } from '../../App.jsx';
import Icon from '../../ui/Icon.jsx';
import { Empty, Link, Loading, Page, Seg } from '../../ui/kit.jsx';
import { useQuery } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { ago, bytes } from '../../lib/format.js';
import { useLookups, SubjectTag } from '../shared/lookups.jsx';
import { LessonBody } from '../tutor/Library.jsx';
import { useReadingTime } from '../shared/FileView.jsx';
import { ReportProblem } from './SelfStudy.jsx';

export default function LearnerLibrary() {
  const app = useApp();
  const lk = useLookups();
  const files = useQuery('files', api.listFiles);
  const lessons = useQuery('lessons', api.listLessons);
  const [subject, setSubject] = useState('');
  const [tab, setTab] = useState('lessons');
  const f = (files.data || []).filter((x) => !subject || x.subject_id === subject);
  const l = (lessons.data || []).filter((x) => !subject || x.subject_id === subject);

  return (
    <Page
      title="Library"
      subtitle={
        app.me.self_learner
          ? 'Lessons for your subjects, topic by topic. New ones appear as StudyBridge adds them. Anything you open is kept on this device for offline use.'
          : 'Lesson notes and books from your tutor. Anything you open is kept on this device for offline use.'
      }
    >
      <div className="row wrap between">
        <Seg
          value={tab}
          onChange={setTab}
          options={[
            { value: 'lessons', label: `Lesson notes (${l.length})`, icon: 'book' },
            { value: 'files', label: `Books & files (${f.length})`, icon: 'file' },
          ]}
        />
        {lk.mySubjects.length > 1 && (
          <select className="select" style={{ width: 'auto', minHeight: 38 }} value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject">
            <option value="">All subjects</option>
            {lk.mySubjects.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
      </div>
      {tab === 'lessons' ? (
        !lessons.data ? (
          <Loading />
        ) : l.length === 0 ? (
          <Empty>No lesson notes yet.</Empty>
        ) : (
          <div className="card">
            <div className="list">
              {l.map((x) => (
                <Link key={x.id} to={`/lesson/${x.id}`} className="item">
                  <Icon name="book" style={{ color: 'var(--accent)' }} />
                  <span className="grow">
                    <span className="name">{x.title}</span>
                    <span className="meta">
                      {x.subject_id && <SubjectTag id={x.subject_id} />}
                      {x.topic_id && <span>{lk.topic(x.topic_id)?.name}</span>}
                      <span>{ago(x.visible_from || x.created_at)}</span>
                    </span>
                  </span>
                  <Icon name="right" size={18} />
                </Link>
              ))}
            </div>
          </div>
        )
      ) : !files.data ? (
        <Loading />
      ) : f.length === 0 ? (
        <Empty>No files yet.</Empty>
      ) : (
        <div className="card">
          <div className="list">
            {f.map((x) => (
              <Link key={x.id} to={`/file/${x.id}`} className="item">
                <Icon name={/pdf/.test(x.mime || '') ? 'pdf' : /image/.test(x.mime || '') ? 'image' : 'file'} style={{ color: 'var(--accent)' }} />
                <span className="grow">
                  <span className="name">{x.name}</span>
                  <span className="meta">
                    {x.subject_id && <SubjectTag id={x.subject_id} />}
                    {x.description && <span>{x.description}</span>}
                    <span>{bytes(x.size)}</span>
                  </span>
                </span>
                <Icon name="right" size={18} />
              </Link>
            ))}
          </div>
        </div>
      )}
    </Page>
  );
}

export function LessonView({ id }) {
  const lessons = useQuery('lessons', api.listLessons);
  const files = useQuery('files', api.listFiles).data || [];
  const x = (lessons.data || []).find((l) => l.id === id);
  useReadingTime(x ? id : null, 'lesson');
  if (!x) return <Page title="Lesson notes">{lessons.data ? <Empty>These lesson notes aren’t available.</Empty> : <Loading />}</Page>;
  const attached = (x.file_ids || []).map((fid) => files.find((f) => f.id === fid)).filter(Boolean);
  return (
    <Page
      size="narrow"
      eyebrow={
        <>
          <Link to="/library">Library</Link> <Icon name="right" size={14} />
        </>
      }
      title={x.title}
      subtitle={x.subject_id ? <SubjectTag id={x.subject_id} /> : null}
    >
      <div className="card" style={{ fontSize: 16 }}>
        <LessonBody md={x.body_md} />
      </div>
      <div>
        <ReportProblem kind="lesson" id={x.id} label="Report a problem with this lesson" />
      </div>
      {attached.length > 0 && (
        <div className="card">
          <h3>With this lesson</h3>
          <div className="list">
            {attached.map((f) => (
              <Link key={f.id} to={`/file/${f.id}`} className="item">
                <Icon name="pdf" style={{ color: 'var(--accent)' }} />
                <span className="grow">
                  <span className="name">{f.name}</span>
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </Page>
  );
}
