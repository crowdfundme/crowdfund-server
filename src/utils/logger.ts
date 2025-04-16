export const logInfo = (message: string, data?: any) => {
    console.log(`${new Date().toISOString()} - INFO: ${message}`, data || "");
  };
  
  export const logError = (message: string, error?: any) => {
    console.error(`${new Date().toISOString()} - ERROR: ${message}`, error || "");
  };