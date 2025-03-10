import { useState } from 'react';
import reactLogo from '@/assets/react.svg';
import wxtLogo from '/wxt.svg';
import './App.css';

function App() {
  const [count, setCount] = useState(0);

  return (
    <>
      <div>
        <a href="https://wxt.dev" target="_blank">
          <img src={wxtLogo} className="logo" alt="WXT logo" />
        </a>
        <a href="https://react.dev" target="_blank">
          <img src={reactLogo} className="logo react" alt="React logo" />
        </a>
      </div>
      <h1>LibSQL OPFS Example</h1>
      <div className="card">
      <button onClick={() => {
          const exampleUrl = browser.runtime.getURL('example.html');
          browser.tabs.create({ url: exampleUrl });
        }}>
          Open example
        </button>
    
      </div>
    
    </>
  );
}

export default App;
