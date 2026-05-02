'use client';

import { useState } from 'react';
import { Download, Link as LinkIcon, Loader2, AlertCircle, CheckCircle2, FileVideo } from 'lucide-react';

type DownloadJob = {
  id: string;
  url: string;
  title?: string;
  progress: number;
  phase: number;
  status: 'pending' | 'processing' | 'merging' | 'downloading' | 'done' | 'error';
  message?: string;
  fileId?: string;
};

export default function Home() {
  const [urls, setUrls] = useState('');
  const [isDownloading, setIsDownloading] = useState(false);
  const [message, setMessage] = useState<{ type: 'error' | 'success', text: string } | null>(null);
  const [jobs, setJobs] = useState<DownloadJob[]>([]);

  const handleDownload = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!urls.trim()) {
      setMessage({ type: 'error', text: 'Please enter at least one YouTube URL' });
      return;
    }

    const urlList = urls.split('\n').map(u => u.trim()).filter(u => u !== '');
    
    if (urlList.length === 0) {
      setMessage({ type: 'error', text: 'Please enter valid YouTube URLs' });
      return;
    }

    if (urlList.length > 10) {
      setMessage({ type: 'error', text: 'You can only download up to 10 videos at once' });
      return;
    }

    const invalidUrls = urlList.filter(u => !u.includes('youtube.com/') && !u.includes('youtu.be/'));
    if (invalidUrls.length > 0) {
      setMessage({ type: 'error', text: 'One or more URLs are not valid YouTube links' });
      return;
    }

    setIsDownloading(true);
    setMessage(null);
    setUrls('');

    const newJobs: DownloadJob[] = urlList.map((u, i) => ({
      id: `job-${Date.now()}-${i}`,
      url: u,
      progress: 0,
      phase: 1,
      status: 'pending'
    }));

    setJobs(prev => [...newJobs, ...prev]);

    // Start all jobs
    newJobs.forEach(job => {
      setJobs(current => current.map(j => j.id === job.id ? { ...j, status: 'processing' } : j));
      
      const eventSource = new EventSource(`/api/process?url=${encodeURIComponent(job.url)}`);
      let jobTitle = `video-${Date.now()}`;
      
      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          
          if (data.status === 'info' && data.title) {
            jobTitle = data.title.replace(/[^\w\s-]/gi, '').trim().replace(/\s+/g, '_') || jobTitle;
          } else if (data.status === 'ready') {
            // Trigger actual browser download (might be blocked by browser due to async delay)
            const link = document.createElement('a');
            link.href = `/api/download?fileId=${data.fileId}&title=${encodeURIComponent(jobTitle)}`;
            link.setAttribute('download', `${jobTitle}.mp4`); 
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            
            eventSource.close();
          } else if (data.status === 'error') {
            eventSource.close();
          }
          
          setJobs(current => current.map(j => {
            if (j.id !== job.id) return j;
            
            if (data.status === 'info' && data.title) {
              return { ...j, title: data.title };
            } else if (data.status === 'processing') {
              return { ...j, progress: data.progress, phase: data.phase || 1 };
            } else if (data.status === 'merging') {
              return { ...j, status: 'merging', progress: 100 };
            } else if (data.status === 'ready') {
              return { ...j, status: 'done', progress: 100, fileId: data.fileId };
            } else if (data.status === 'error') {
              return { ...j, status: 'error', message: data.message };
            }
            
            return j;
          }));
        } catch (err) {
          console.error("Error parsing SSE data", err);
        }
      };

      eventSource.onerror = () => {
        eventSource.close();
        setJobs(current => current.map(j => 
          j.id === job.id && j.status !== 'done' 
            ? { ...j, status: 'error', message: 'Connection lost' } 
            : j
        ));
      };
    });
    
    setIsDownloading(false);
  };

  const getJobStatusText = (job: DownloadJob) => {
    switch (job.status) {
      case 'pending': return 'Waiting...';
      case 'processing': return `Downloading (Phase ${job.phase}/2)... ${job.progress}%`;
      case 'merging': return 'Merging Audio & Video...';
      case 'done': return 'Download Complete!';
      case 'error': return 'Failed: ' + (job.message || 'Unknown error');
      default: return '';
    }
  };

  return (
    <main className="container">
      <div className="glass-panel">
        <h1 className="title">Vortex</h1>
        <p className="subtitle">High-quality YouTube MP4 Downloader</p>

        <form onSubmit={handleDownload}>
          <div className="form-group">
            <label htmlFor="url" className="input-label">Video URLs (up to 10, one per line)</label>
            <div className="input-wrapper align-top">
              <LinkIcon className="input-icon textarea-icon" size={20} />
              <textarea
                id="url"
                className="url-input textarea-input"
                placeholder="https://www.youtube.com/watch?v=...&#10;https://www.youtube.com/watch?v=..."
                value={urls}
                onChange={(e) => setUrls(e.target.value)}
                rows={5}
                disabled={isDownloading}
              />
            </div>
          </div>

          <button 
            type="submit" 
            className="btn-download"
            disabled={isDownloading || !urls}
          >
            {isDownloading ? (
              <>
                <Loader2 className="spinner" size={20} />
                Starting Jobs...
              </>
            ) : (
              <>
                <Download size={20} />
                Download MP4
              </>
            )}
          </button>
        </form>

        {message && (
          <div className={`message ${message.type}`}>
            {message.type === 'error' ? <AlertCircle size={20} /> : <CheckCircle2 size={20} />}
            <span>{message.text}</span>
          </div>
        )}

        {jobs.length > 0 && (
          <div className="jobs-container">
            {jobs.map((job, index) => (
              <div key={job.id} className="job-card">
                <div className="job-header">
                  <div className="job-title" title={job.title}>
                    <FileVideo size={16} />
                    <span>{job.title || `Video #${jobs.length - index}`}</span>
                  </div>
                  <div className={`job-status status-${job.status}`}>
                    {job.status === 'processing' || job.status === 'merging' ? (
                      <Loader2 className="spinner" size={14} />
                    ) : job.status === 'done' ? (
                      <CheckCircle2 size={14} />
                    ) : job.status === 'error' ? (
                      <AlertCircle size={14} />
                    ) : null}
                    <span>{getJobStatusText(job)}</span>
                  </div>
                </div>
                
                {(job.status === 'processing' || job.status === 'merging' || job.status === 'done') && (
                  <div className="progress-bar-container">
                    <div 
                      className={`progress-bar-fill ${job.status === 'merging' ? 'merging' : ''} ${job.status === 'done' ? 'done' : ''}`}
                      style={{ width: `${job.progress}%` }}
                    />
                  </div>
                )}
                
                <div className="job-footer">
                  <div className="job-url" title={job.url}>{job.url}</div>
                  {job.status === 'done' && job.fileId && (
                    <a 
                      href={`/api/download?fileId=${job.fileId}&title=${encodeURIComponent(job.title || `video-${job.id}`)}`} 
                      download={`${job.title ? job.title.replace(/[^\w\s-]/gi, '').trim().replace(/\s+/g, '_') : `video-${job.id}`}.mp4`}
                      className="btn-save-manual"
                    >
                      Save File
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
