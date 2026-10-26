import { Route, Routes } from 'react-router';
import { Landing } from './routes/Landing';
import { RoomRoute } from './routes/Room';
import { Lab } from './routes/Lab';
import { NotFound } from './routes/NotFound';

export function App() {
  return (
    <div className="aurora relative isolate min-h-dvh">
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/r/:code" element={<RoomRoute />} />
        <Route path="/lab" element={<Lab />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </div>
  );
}
