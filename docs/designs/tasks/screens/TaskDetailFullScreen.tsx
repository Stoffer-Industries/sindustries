import React from "react";
import * as Icons from "lucide-react";

export interface TaskDetailFullScreenProps {
  state: string;
}

/**
 * States:
 * - default: Read-only view of the task details. Shows title, description, metadata, and audit trail.
 * - editing: Edit mode active. Form fields are visible and populated. Save/Cancel buttons available.
 */
const TaskDetailFullScreen: React.FC<TaskDetailFullScreenProps> = ({ state }) => {
  
  const isEditing = state === 'editing';

  // --- Render Helpers ---

  const renderNav = () => (
    <nav className="sticky top-0 z-50 bg-[#1E1E1E] border-b-[3px] border-[#FFE135] px-4 py-3 flex items-center gap-4 shadow-lg">
      <button className="bg-[#2a2a2a] p-2 border-2 border-[#555] hover:border-[#00D4FF] transition-colors group">
        <Icons.ArrowLeft className="w-5 h-5 text-[#F5F2E8] group-hover:text-[#00D4FF]" />
      </button>
      <div className="flex-1">
        <div className="bg-[#FFE135] text-[#1E1E1E] px-2 py-1 border-2 border-[#000000] inline-block transform -rotate-1 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]">
          <span className="font-['Dela_Gothic_One'] text-xl tracking-tight uppercase">Task Detail</span>
        </div>
      </div>
      <button className="md:hidden bg-[#2a2a2a] p-2 border-2 border-[#555] text-[#F5F2E8]">
        <Icons.MoreVertical className="w-5 h-5" />
      </button>
    </nav>
  );

  const renderPriorityBadge = (level: string) => {
    const baseClasses = "inline-flex items-center gap-1 border-2 border-[#000000] font-['Work_Sans'] font-bold uppercase tracking-wider text-sm px-3 py-1 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] ";
    if (level === 'urgent') return <span className={`${baseClasses} bg-[#FF3E8A] text-white`}><Icons.Flame className="w-4 h-4 fill-current" /> Urgent</span>;
    if (level === 'high') return <span className={`${baseClasses} bg-[#FFE135] text-black`}><Icons.Bolt className="w-4 h-4 fill-current" /> High</span>;
    if (level === 'medium') return <span className={`${baseClasses} bg-[#00D4FF] text-black`}>Medium</span>;
    return <span className={`${baseClasses} bg-[#666666] text-white`}>Low</span>;
  };

  const renderStickyFooter = () => (
    <div className="fixed bottom-0 left-0 right-0 bg-[#1E1E1E] border-t-[3px] border-[#555] p-4 pb-6 z-40 md:hidden">
      <div className="flex gap-3">
        <button className="flex-1 bg-[#FFE135] text-[#1E1E1E] font-['Dela_Gothic_One'] text-lg px-4 py-3 border-[3px] border-[#000000] shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] hover:translate-y-[1px] transition-all uppercase">
          Save Changes
        </button>
        <button className="w-16 bg-[#FF3E8A] text-white border-[3px] border-[#000000] shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] flex items-center justify-center">
          <Icons.Trash2 className="w-6 h-6" />
        </button>
      </div>
    </div>
  );

  const renderContent = () => {
    return (
      <div className="max-w-4xl mx-auto w-full p-4 md:p-8 space-y-6 pb-24 md:pb-8">
        
        {/* Main Sticker Card */}
        <div className="bg-[#F5F2E8] border-[3px] border-[#000000] p-6 md:p-8 shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] relative transform rotate-[0.5deg]">
          
          {/* Header Actions */}
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-6">
            <div className="flex gap-3">
              {renderPriorityBadge('urgent')}
              {isEditing ? (
                <select className="bg-[#00D4FF] text-[#1E1E1E] border-[3px] border-[#000000] px-3 py-1.5 font-['Work_Sans'] font-bold uppercase text-xs shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] focus:outline-none focus:border-[#1E1E1E] h-[28px] min-w-[80px]">
                  <option value="todo">Todo</option>
                  <option value="doing" selected>Doing</option>
                  <option value="done">Done</option>
                </select>
              ) : (
                <span className="bg-[#00D4FF] text-[#1E1E1E] border-[3px] border-[#000000] px-3 py-1.5 font-['Work_Sans'] font-bold uppercase text-xs shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] inline-block h-[28px] min-w-[80px] flex items-center justify-center">
                  Doing
                </span>
              )}
            </div>
            
            {!isEditing ? (
              <div className="flex gap-2 md:hidden">
                <button className="bg-[#FFE135] border-2 border-[#000000] px-4 py-2 font-['Work_Sans'] uppercase shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] text-sm">
                  Edit
                </button>
              </div>
            ) : (
              <div className="flex gap-2">
                <button className="bg-[#666] text-white border-2 border-[#000000] px-3 py-1 font-['Work_Sans'] font-bold uppercase shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] hover:translate-y-[1px] transition-all text-sm">
                  Cancel
                </button>
              </div>
            )}
          </div>

          {/* Title */}
          <div className="mb-6">
            {isEditing ? (
              <input 
                type="text" 
                defaultValue="Redesign Main Landing Page" 
                className="w-full bg-white border-[3px] border-[#000000] text-xl md:text-3xl font-['Dela_Gothic_One'] text-[#1E1E1E] leading-tight focus:outline-none focus:border-[#00D4FF] focus:bg-[#E6F7FF] px-3 py-2 min-h-[48px] shadow-[2px_2px_0px_0px_rgba(0,0,0,0.3)]" 
              />
            ) : (
              <h1 className="text-2xl md:text-5xl font-['Dela_Gothic_One'] text-[#1E1E1E] leading-tight">
                Redesign Main Landing Page
              </h1>
            )}
          </div>

          {/* Description */}
          <div className="mb-6">
            <h3 className="text-xs font-bold font-['Work_Sans'] uppercase text-[#666] mb-2 tracking-widest">Description</h3>
            {isEditing ? (
              <textarea 
                rows={6} 
                className="w-full bg-white border-[3px] border-[#000000] p-3 font-['Work_Sans'] text-[#1E1E1E] focus:outline-none focus:border-[#00D4FF] focus:bg-[#E6F7FF] resize-y min-h-[150px] shadow-inner overflow-y-auto"
                defaultValue="The current landing page is too clean. We need to apply the new Thrashed Sticker Bomb aesthetic. Use high contrast colors, rotate elements, and add noise textures."
              />
            ) : (
              <p className="font-['Work_Sans'] text-base md:text-lg text-[#333] leading-relaxed">
                The current landing page is too clean. We need to apply the new Thrashed Sticker Bomb aesthetic. Use high contrast colors, rotate elements, and add noise textures.
              </p>
            )}
          </div>

          {/* Metadata Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Assignee */}
            <div className="bg-white border-[3px] border-[#000000] p-3 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] flex flex-col justify-center">
              <h3 className="text-[10px] font-bold font-['Work_Sans'] uppercase text-[#888] mb-2">Assignee</h3>
              {isEditing ? (
                <input type="text" defaultValue="Alex" className="w-full bg-[#E6F7FF] font-['Work_Sans'] font-bold text-[#1E1E1E] focus:outline-none border-2 border-[#00D4FF] px-2 py-1.5 shadow-inner" />
              ) : (
                <div className="flex items-center gap-2 font-['Work_Sans'] font-bold text-[#1E1E1E]">
                  <Icons.User className="w-4 h-4 text-[#00D4FF]" /> Alex
                </div>
              )}
            </div>

            {/* Due Date */}
            <div className="bg-white border-[3px] border-[#000000] p-3 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] flex flex-col justify-center">
              <h3 className="text-[10px] font-bold font-['Work_Sans'] uppercase text-[#888] mb-2">Due Date</h3>
              {isEditing ? (
                <input type="date" defaultValue="2023-10-24" className="w-full bg-[#E6F7FF] font-['Work_Sans'] font-bold text-[#1E1E1E] focus:outline-none border-2 border-[#00D4FF] px-2 py-1.5 shadow-inner" />
              ) : (
                <div className="flex items-center gap-2 font-['Work_Sans'] font-bold text-[#1E1E1E]">
                  <Icons.Calendar className="w-4 h-4 text-[#FF3E8A]" /> Oct 24, 2023
                </div>
              )}
            </div>

            {/* Tags */}
            <div className="bg-white border-2 border-[#000000] p-3 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]">
              <h3 className="text-[10px] font-bold font-['Work_Sans'] uppercase text-[#888] mb-1">Tags</h3>
              <div className="flex flex-wrap gap-2">
                <span className="bg-[#00D4FF] text-[#1E1E1E] text-xs font-bold font-['Work_Sans'] px-2 py-0.5 border border-[#000] transform -rotate-1">Design</span>
                <span className="bg-[#FFE135] text-[#1E1E1E] text-xs font-bold font-['Work_Sans'] px-2 py-0.5 border border-[#000] transform rotate-1">Web</span>
                {isEditing && <button className="text-[#666] text-xs font-bold uppercase underline">+ Add Tag</button>}
              </div>
            </div>
          </div>
        </div>

        {/* Audit Trail Sticker */}
        <div className="bg-[#F5F2E8] border-[3px] border-[#000000] p-6 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] transform -rotate-[1deg] mt-8">
          <h2 className="text-xl font-['Dela_Gothic_One'] text-[#1E1E1E] uppercase mb-4 border-b-2 border-dashed border-[#000] pb-2 flex items-center gap-2">
            <Icons.ClipboardList className="w-5 h-5" /> Audit Trail
          </h2>
          <div className="space-y-3 font-['Work_Sans'] text-sm">
            <div className="flex justify-between items-center text-[#666]">
              <span>Created</span>
              <span className="font-bold text-[#1E1E1E]">Oct 10, 2023</span>
            </div>
            <div className="flex justify-between items-center text-[#666]">
              <span>Last Updated</span>
              <span className="font-bold text-[#1E1E1E]">Oct 22, 2023</span>
            </div>
            <div className="flex justify-between items-center text-[#666]">
              <span>Status Changed</span>
              <span className="font-bold text-[#00D4FF]">Todo → Doing</span>
            </div>
          </div>
        </div>

      </div>
    );
  };

  return (
    <div className="min-h-screen bg-[#1E1E1E] flex flex-col font-['Work_Sans']">
      {renderNav()}
      {renderContent()}
      {isEditing && renderStickyFooter()}
    </div>
  );
};

export default TaskDetailFullScreen;